import { match } from "ts-pattern";
import { REQUEST_RESOURCES } from "@shared/types/query-protocol";
import {
  type QueryParams,
  readStringParam,
  readNumberParam,
  requireParam,
} from "../lib/query-params";
import { delegateToRoute } from "./route-delegate";
import { getSimulatorCapabilities } from "./simulator-context";

export type RequestResourceName = (typeof REQUEST_RESOURCES)[number];

export interface RequestContext {
  relayClient: boolean;
}

/**
 * Route one-shot request resources to existing Hono endpoints.
 * Uses delegateToRoute() so business logic stays in the route handlers.
 */
export async function runRequest(
  resource: RequestResourceName,
  params: QueryParams,
  context: RequestContext
): Promise<unknown> {
  /** GET /api/workspaces/:id{path} — covers the 10+ workspace-scoped reads. */
  const wsGet = (path = "") =>
    delegateToRoute(
      "GET",
      `/api/workspaces/${encodeURIComponent(requireParam(params, "workspaceId", resource))}${path}`
    );
  /** GET /api/repos/:id{path} — covers repo-scoped reads. */
  const repoGet = (path = "") =>
    delegateToRoute(
      "GET",
      `/api/repos/${encodeURIComponent(requireParam(params, "repoId", resource))}${path}`
    );

  return match(resource)
    .with("settings", () => delegateToRoute("GET", "/api/settings"))
    .with("repos", () => delegateToRoute("GET", "/api/repos"))
    .with("repoManifest", () => repoGet("/manifest"))
    .with("detectManifest", () => repoGet("/detect-manifest"))
    .with("agentConfig", () => {
      const section = readStringParam(params, "section") ?? "agents";
      const scope = readStringParam(params, "scope") ?? "global";
      const repoPath = readStringParam(params, "repoPath");
      const qs = new URLSearchParams({ scope });
      if (repoPath) qs.set("repoPath", repoPath);
      return delegateToRoute(
        "GET",
        `/api/agent-config/${encodeURIComponent(section)}?${qs.toString()}`
      );
    })
    .with("ghStatus", () => delegateToRoute("GET", "/api/gh-status"))
    .with("prStatus", () => wsGet("/pr-status"))
    .with("workspace", () => wsGet())
    .with("allWorkspaces", () => delegateToRoute("GET", "/api/workspaces"))
    .with("workspaceManifest", () => wsGet("/manifest"))
    .with("setupLogs", () => wsGet("/setup-logs"))
    .with("diffStats", () => wsGet("/diff-stats"))
    .with("diffFiles", () => wsGet("/diff-files"))
    .with("diffFile", () => {
      const wsId = requireParam(params, "workspaceId", "diffFile");
      const file = requireParam(params, "file", "diffFile");
      return delegateToRoute(
        "GET",
        `/api/workspaces/${encodeURIComponent(wsId)}/diff-file?file=${encodeURIComponent(file)}`
      );
    })
    .with("penFiles", () => wsGet("/pen-files"))
    .with("workspaceFiles", () => wsGet("/files"))
    .with("fileContent", () => {
      const wsId = requireParam(params, "workspaceId", "fileContent");
      const filePath = requireParam(params, "path", "fileContent");
      return delegateToRoute(
        "GET",
        `/api/workspaces/${encodeURIComponent(wsId)}/file-content?path=${encodeURIComponent(filePath)}`
      );
    })
    .with("fileSearch", () => {
      const wsId = requireParam(params, "workspaceId", "fileSearch");
      const query = readStringParam(params, "query") ?? "";
      const limit = readNumberParam(params, "limit");
      return delegateToRoute("POST", `/api/workspaces/${encodeURIComponent(wsId)}/files/search`, {
        query,
        ...(limit !== undefined ? { limit } : {}),
      });
    })
    .with("recentProjects", () => delegateToRoute("GET", "/api/onboarding/recent-projects"))
    .with("pairedDevices", () => delegateToRoute("GET", "/api/remote-auth/devices"))
    .with("relayStatus", () => delegateToRoute("GET", "/api/relay/status"))
    .with("simulatorCapabilities", () =>
      getSimulatorCapabilities({ relayClient: context.relayClient })
    )
    .with("allSessions", () => delegateToRoute("GET", "/api/sessions"))
    .with("repoPrs", () => repoGet("/prs"))
    .with("repoBranches", () => repoGet("/branches"))
    .with("agentAuth", () => delegateToRoute("GET", "/api/settings/agent-auth"))
    .exhaustive();
}
