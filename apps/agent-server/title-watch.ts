// agent-server/title-watch.ts
// Best-effort session title after a successful claude turn: the SDK
// auto-summarizes sessions; the backend names the session AND an untitled
// workspace from the pushed title. Runs agent-server-side because it needs
// the claude SDK's listSessions against the session's cwd; the result rides
// the deus/title side-channel notification. Fire-and-forget.

import { SIDE_CHANNEL } from "@shared/agent-side-channel";
import { notifyHost } from "./host-link";
import { trackedSessions } from "./session-tracker";

/** Sessions with a fetch in flight — rapid turn ends must not double-push. */
const inFlight = new Set<string>();

/** Kick a title fetch after a turn ended cleanly (idle, not error/cancel). */
export function maybeFetchTitle(sessionId: string): void {
  const state = trackedSessions.get(sessionId);
  if (!state || state.harness !== "claude-code" || state.titleFetched) return;
  const { cwd, nativeSessionId } = state;
  if (!cwd || !nativeSessionId) return;
  if (inFlight.has(sessionId)) return;
  inFlight.add(sessionId);
  void (async () => {
    try {
      const { listSessions } = await import("@anthropic-ai/claude-agent-sdk");
      const sessions = await listSessions({ dir: cwd, limit: 20 });
      const title = sessions.find((s) => s.sessionId === nativeSessionId)?.summary;
      if (title) {
        // Flag only on DELIVERY: the SDK summary usually lags the first turn
        // (retry until one exists), and a backend disconnect at push time
        // must not burn the only attempt — the next turn end retries.
        const delivered = notifyHost(SIDE_CHANNEL.title, {
          sessionId,
          agentHarness: "claude-code",
          title,
        });
        if (delivered) state.titleFetched = true;
      }
    } catch (error) {
      console.error(`[title-watch] title fetch failed for ${sessionId}:`, error);
    } finally {
      inFlight.delete(sessionId);
    }
  })();
}
