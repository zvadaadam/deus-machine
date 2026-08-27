// backend/src/services/automations/agent-rpc.ts
// The agent's automation_update tool lands here (deus/automation/update on the
// side channel). Defaults resolve from the CALLING session — repository and
// model — so the agent never guesses ids it doesn't have. Writes go through
// the same service the q:mutate arms use; everything executes in Deus Cloud.

import { getDatabase } from "../../lib/database";
import { getSessionRaw, getWorkspaceRaw } from "../../db";
import {
  createAutomation,
  deleteAutomation,
  getAutomation,
  listAutomations,
  listAutomationRuns,
  refreshAutomations,
  toggleAutomation,
  updateAutomation,
  type AutomationInput,
} from "./service";
import { getAutomationRaw } from "./store";

interface SessionDefaults {
  repository_id: string;
  model: string | null;
}

function defaultsFromSession(sessionId: string): SessionDefaults {
  const db = getDatabase();
  const session = getSessionRaw(db, sessionId);
  if (!session) throw new Error(`automation: session not found: ${sessionId}`);
  const workspace = getWorkspaceRaw(db, session.workspace_id);
  if (!workspace) throw new Error(`automation: workspace not found: ${session.workspace_id}`);
  // The session's current model lives on its message rows (model is per-turn).
  // Automation runs are Claude sandboxes, so only a claude-code session's
  // model carries over; anything else falls back to the platform default.
  const lastModel = db
    .prepare(
      `SELECT model FROM messages
        WHERE session_id = ? AND model IS NOT NULL
        ORDER BY seq DESC LIMIT 1`
    )
    .get(sessionId) as { model: string } | undefined;
  return {
    repository_id: workspace.repository_id,
    model: session.agent_harness === "claude-code" ? (lastModel?.model ?? null) : null,
  };
}

/** Resolve an automationId that may be an agnt id or an exact display name. */
function resolveAutomationId(ref: string): string {
  if (getAutomationRaw(ref)) return ref;
  const byName = getDatabase()
    .prepare("SELECT id FROM automations WHERE name = ? ORDER BY id DESC")
    .all(ref) as Array<{ id: string }>;
  if (byName.length === 1) return byName[0].id;
  if (byName.length > 1) {
    throw new Error(`automation: name "${ref}" is ambiguous — use the id (mode=list to see them).`);
  }
  throw new Error(`automation: not found: ${ref}`);
}

function readString(params: Record<string, unknown>, key: string): string | undefined {
  return typeof params[key] === "string" ? (params[key] as string) : undefined;
}

export async function handleAutomationToolRequest(
  params: Record<string, unknown>
): Promise<unknown> {
  const sessionId = readString(params, "sessionId");
  if (!sessionId) throw new Error("automation: sessionId is required");
  const mode = readString(params, "mode");

  switch (mode) {
    case "list":
      await refreshAutomations().catch(() => {
        // Stale cache beats a failed list — the platform may be briefly away.
      });
      return { automations: listAutomations() };

    case "view": {
      const id = resolveAutomationId(requireRef(params));
      await refreshAutomations(id).catch(() => {});
      return { automation: getAutomation(id), runs: listAutomationRuns(id).slice(0, 10) };
    }

    case "create": {
      const defaults = defaultsFromSession(sessionId);
      const input: AutomationInput = {
        repository_id: readString(params, "repositoryId") ?? defaults.repository_id,
        name: readString(params, "name") ?? "",
        prompt: readString(params, "prompt") ?? "",
        cron: readString(params, "cron") ?? "",
        timezone: readString(params, "timezone") ?? null,
        session_policy: readString(params, "sessionPolicy"),
        model: readString(params, "model") ?? defaults.model,
      };
      return { automation: await createAutomation(input, "agent") };
    }

    case "update": {
      const id = resolveAutomationId(requireRef(params));
      const patch: Partial<AutomationInput> = {};
      const name = readString(params, "name");
      const prompt = readString(params, "prompt");
      const cron = readString(params, "cron");
      const sessionPolicy = readString(params, "sessionPolicy");
      if (name !== undefined) patch.name = name;
      if (prompt !== undefined) patch.prompt = prompt;
      if (cron !== undefined) patch.cron = cron;
      if ("timezone" in params) patch.timezone = readString(params, "timezone") ?? null;
      if (sessionPolicy !== undefined) patch.session_policy = sessionPolicy;
      if ("model" in params) patch.model = readString(params, "model") ?? null;

      let automation =
        Object.keys(patch).length > 0 ? await updateAutomation(id, patch) : getAutomation(id);
      const status = readString(params, "status");
      if (status === "active" || status === "paused") {
        automation = await toggleAutomation(id, status);
      }
      return { automation };
    }

    case "delete": {
      const id = resolveAutomationId(requireRef(params));
      await deleteAutomation(id);
      return { deleted: true };
    }

    default:
      throw new Error(`automation: unknown mode "${mode}"`);
  }
}

function requireRef(params: Record<string, unknown>): string {
  const ref = readString(params, "automationId");
  if (!ref) throw new Error("automation: automationId is required for this mode");
  return ref;
}
