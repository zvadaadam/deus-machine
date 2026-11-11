// agent-server/host-link.ts
// The deus MCP tools' handle on the backend, which runs the engine in its own
// process: the backend registers itself once (`setHost`, from `startEngine`),
// and each tool's request is a call into it, bounded by the tool's deadline.

import type {
  GetDiffRequest,
  GetDiffResponse,
  DiffCommentRequest,
  DiffCommentResponse,
  GetTerminalOutputRequest,
  GetTerminalOutputResponse,
  AutomationUpdateRequest,
  AutomationUpdateResponse,
} from "./rpc-schemas";

/** A session's title, from Claude's own summary. */
export interface SessionTitle {
  sessionId: string;
  agentHarness: string;
  title: string;
}

/** What the backend answers for the engine. */
export interface DeusHost {
  /** A deus MCP tool's request (getDiff, automation/update, …). */
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  /** A session's title, to name the session and an untitled workspace. */
  title(payload: SessionTitle): void;
}

/** Timeout for data-fetching requests that should resolve quickly. */
const DATA_QUERY_TIMEOUT_MS = 10_000;

/** Timeout for automation writes — Deus Cloud round-trips, possibly including
 *  a lazy environment create before the automation itself. */
const AUTOMATION_TIMEOUT_MS = 30_000;

let host: DeusHost | null = null;

/** The backend, or none (it stopped the engine). */
export function setHost(next: DeusHost | null): void {
  host = next;
}

function requestHost<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
  if (!host) return Promise.reject(new Error("Deus host not connected."));
  const answer = host.request(method, params as Record<string, unknown>);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${method} timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    answer.then(
      (value) => {
        clearTimeout(timer);
        resolve(value as T);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/** A session's title for the backend; false when none is registered (the next turn end retries). */
export function notifyTitle(payload: SessionTitle): boolean {
  if (!host) return false;
  host.title(payload);
  return true;
}

/** Typed request facade to the backend: the deus MCP tools' data fetches. */
export const HostRpc = {
  requestGetDiff(r: GetDiffRequest): Promise<GetDiffResponse> {
    return requestHost("getDiff", r, DATA_QUERY_TIMEOUT_MS);
  },
  requestDiffComment(r: DiffCommentRequest): Promise<DiffCommentResponse> {
    return requestHost("diffComment", r, DATA_QUERY_TIMEOUT_MS);
  },
  requestGetTerminalOutput(r: GetTerminalOutputRequest): Promise<GetTerminalOutputResponse> {
    return requestHost("getTerminalOutput", r, DATA_QUERY_TIMEOUT_MS);
  },
  requestSimulatorContext(r: {
    sessionId: string;
  }): Promise<{ udid: string; port?: number; streaming: boolean } | null> {
    return requestHost("getSimulatorContext", r, DATA_QUERY_TIMEOUT_MS);
  },
  requestAutomationUpdate(r: AutomationUpdateRequest): Promise<AutomationUpdateResponse> {
    // Cloud round-trips: a create may lazily provision the repo's platform
    // environment before the automation itself — give it real headroom.
    return requestHost("automation/update", r, AUTOMATION_TIMEOUT_MS);
  },
};
