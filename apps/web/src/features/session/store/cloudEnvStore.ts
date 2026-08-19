/**
 * Ephemeral cloud environment progress — the q:event "cloud:env" stream.
 *
 * The backend passes agnt's workspace.state events through verbatim while a
 * cloud session socket is up (provisioning steps, wake/restore, pause, error).
 * The chat renders them as a live progress stack. Nothing here is persisted:
 * no DB, no localStorage — a refresh clears the stack by design. The durable
 * truth (workspace state/init_stage) lives on the workspace row.
 */

import { create } from "zustand";
import { CloudEnvEventSchema } from "@shared/events";
import { onEvent } from "@/platform/ws/query-protocol-client";

/** One received environment event, as the chat stack consumes it. */
export interface CloudEnvEntry {
  id: number;
  /** agnt workspace status: provisioning | running | paused | stopped | error */
  status: string;
  /** Provisioning step label (e.g. "cloning_repository") when status is provisioning. */
  step: string | null;
  /** Pause/stop/error detail from the platform, when it sends one. */
  reason: string | null;
  /** running events only: the sandbox came back with session state restored. */
  snapshotRestored: boolean;
  /** Arrival time (debugging/future ordering; the UI renders insertion order). */
  at: number;
}

interface CloudEnvStore {
  byWorkspace: Record<string, CloudEnvEntry[]>;
}

const MAX_EVENTS_PER_WORKSPACE = 16;
let nextId = 1;

export const useCloudEnvStore = create<CloudEnvStore>()(() => ({
  byWorkspace: {},
}));

function append(workspaceId: string, event: Omit<CloudEnvEntry, "id" | "at">): void {
  useCloudEnvStore.setState((state) => {
    const existing = state.byWorkspace[workspaceId] ?? [];
    // Reconnects can re-announce the current state — an identical
    // status/step to the latest entry adds nothing to the stack.
    const last = existing[existing.length - 1];
    if (last && last.status === event.status && last.step === event.step) return state;
    const entry: CloudEnvEntry = { ...event, id: nextId++, at: Date.now() };
    return {
      byWorkspace: {
        ...state.byWorkspace,
        [workspaceId]: [...existing, entry].slice(-MAX_EVENTS_PER_WORKSPACE),
      },
    };
  });
}

// One process-wide listener regardless of how many chats are mounted —
// per-component subscriptions would double-append the shared log.
let subscribed = false;

export function ensureCloudEnvSubscription(): void {
  if (subscribed) return;
  subscribed = true;

  onEvent((event, raw) => {
    if (event !== "cloud:env") return;
    const parsed = CloudEnvEventSchema.safeParse(raw);
    if (!parsed.success) return;
    const { workspaceId, data } = parsed.data;

    append(workspaceId, {
      status: data.status,
      step: data.step ?? null,
      reason: data.errorMessage ?? data.reason ?? null,
      snapshotRestored: data.snapshotRestored === true,
    });
  });
}
