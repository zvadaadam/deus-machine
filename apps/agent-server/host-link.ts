// agent-server/host-link.ts
// The agent-server's handle on the Deus backend ("the host"): the one
// connected side-channel endpoint that answers tool round-trips. The backend
// marks itself with a `deus/hello` notification after connecting; a debug CLI
// that doesn't hello never receives tool traffic.
//
// This module replaces the request half of the old EventBroadcaster — the
// typed HostRpc facade keeps the same method names so the deus-tools call
// sites read identically.

import type { SideChannelEndpoint } from "@shared/agent-side-channel";
import { SIDE_CHANNEL } from "@shared/agent-side-channel";
import type {
  AskUserQuestionRequest,
  AskUserQuestionResponse,
  GetDiffRequest,
  GetDiffResponse,
  DiffCommentRequest,
  DiffCommentResponse,
  GetTerminalOutputRequest,
  GetTerminalOutputResponse,
  ExitPlanModeRequest,
  ExitPlanModeResponse,
  ListAppsRequest,
  ListAppsResponse,
  LaunchAppRequest,
  LaunchAppResponse,
  StopAppRequest,
  StopAppResponse,
  ReadAppSkillRequest,
  ReadAppSkillResponse,
} from "./rpc-schemas";

/** Timeout for data-fetching requests that should resolve quickly. */
const DATA_QUERY_TIMEOUT_MS = 10_000;

/** Timeout for AAP `launch_app`. The manifest's ready-probe caps at 30s and
 *  the backend adds probe-setup + storage-dir work on top. 60s keeps first-
 *  time launches (binary not yet downloaded) from tripping the timeout. */
const AAP_LAUNCH_TIMEOUT_MS = 60_000;

let host: SideChannelEndpoint | null = null;

/** Mark a connection as the Deus host (it sent `deus/hello`). */
export function setHost(endpoint: SideChannelEndpoint): void {
  host = endpoint;
  console.log("[host-link] Deus host attached");
}

/** Clear the host when its transport closes (only if it still IS the host). */
export function clearHost(endpoint: SideChannelEndpoint): void {
  if (host === endpoint) {
    host = null;
    console.log("[host-link] Deus host detached");
  }
}

export function hasHost(): boolean {
  return host !== null;
}

function requestHost<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
  if (!host) {
    return Promise.reject(new Error("Deus host not connected."));
  }
  return host.request<T>(method, params, timeoutMs);
}

/** Fire-and-forget notification to the host (dropped when none attached). */
export function notifyHost(method: string, params: unknown): void {
  host?.notify(method, params);
}

/**
 * Typed request facade to the backend. User-facing requests (plan approval,
 * questions) wait indefinitely — the user may close the laptop and return
 * later. Only data-fetch requests use timeouts.
 */
export const HostRpc = {
  requestExitPlanMode(r: ExitPlanModeRequest): Promise<ExitPlanModeResponse> {
    return requestHost(SIDE_CHANNEL.exitPlanMode, r);
  },
  requestAskUserQuestion(r: AskUserQuestionRequest): Promise<AskUserQuestionResponse> {
    return requestHost(SIDE_CHANNEL.askUserQuestion, r);
  },
  requestGetDiff(r: GetDiffRequest): Promise<GetDiffResponse> {
    return requestHost(SIDE_CHANNEL.getDiff, r, DATA_QUERY_TIMEOUT_MS);
  },
  requestDiffComment(r: DiffCommentRequest): Promise<DiffCommentResponse> {
    return requestHost(SIDE_CHANNEL.diffComment, r, DATA_QUERY_TIMEOUT_MS);
  },
  requestGetTerminalOutput(r: GetTerminalOutputRequest): Promise<GetTerminalOutputResponse> {
    return requestHost(SIDE_CHANNEL.getTerminalOutput, r, DATA_QUERY_TIMEOUT_MS);
  },
  requestSimulatorContext(r: {
    sessionId: string;
  }): Promise<{ udid: string; port?: number; streaming: boolean } | null> {
    return requestHost(SIDE_CHANNEL.getSimulatorContext, r, DATA_QUERY_TIMEOUT_MS);
  },
  requestListApps(r: ListAppsRequest): Promise<ListAppsResponse> {
    return requestHost(SIDE_CHANNEL.aapListApps, r, DATA_QUERY_TIMEOUT_MS);
  },
  requestLaunchApp(r: LaunchAppRequest): Promise<LaunchAppResponse> {
    return requestHost(SIDE_CHANNEL.aapLaunchApp, r, AAP_LAUNCH_TIMEOUT_MS);
  },
  requestStopApp(r: StopAppRequest): Promise<StopAppResponse> {
    return requestHost(SIDE_CHANNEL.aapStopApp, r, DATA_QUERY_TIMEOUT_MS);
  },
  requestReadAppSkill(r: ReadAppSkillRequest): Promise<ReadAppSkillResponse> {
    return requestHost(SIDE_CHANNEL.aapReadAppSkill, r, DATA_QUERY_TIMEOUT_MS);
  },
};
