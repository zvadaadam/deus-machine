/**
 * What this client knows about the workspaces it watched start.
 *
 * `pending` — the message typed before a workspace existed, waiting for its
 * first chat (delivered by session/hooks/useFirstMessageDelivery). Keyed by
 * workspace, so one workspace becoming ready cannot send another's. It stays
 * until it is delivered: a start that fails keeps it, and a retry of the same
 * workspace sends it. Each browser tab keeps its own so two tabs cannot send
 * the same message. A saved message survives a quit on the single-window desktop.
 *
 * `startedIn` — the chat a workspace started with. That chat tells the story
 * of the start (its steps, its warnings) under its first message, the way a
 * cloud chat keeps its computer's provisioning; later chats, and this one
 * after a reload, do not. It is kept in memory only.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { ThinkingLevel } from "@/shared/agents";
import { windowStorage } from "@/shared/stores/windowStorage";

export interface PendingFirstMessage {
  message: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
  /** Sent in plan mode (a message typed in the start page's composer may be). */
  planMode?: boolean;
}

interface WorkspaceStartStore {
  pending: Record<string, PendingFirstMessage>;
  startedIn: Record<string, string>;
}

export const useWorkspaceStartStore = create<WorkspaceStartStore>()(
  persist(
    (): WorkspaceStartStore => ({
      pending: {},
      startedIn: {},
    }),
    {
      name: "workspace-start",
      version: 1,
      storage: createJSONStorage(() => windowStorage),
      partialize: (state) => ({ pending: state.pending }),
    }
  )
);

export const pendingFirstMessages = {
  get: (workspaceId: string): PendingFirstMessage | undefined =>
    useWorkspaceStartStore.getState().pending[workspaceId],

  set: (workspaceId: string, pending: PendingFirstMessage): void => {
    useWorkspaceStartStore.setState((state) => ({
      pending: { ...state.pending, [workspaceId]: pending },
    }));
  },

  clear: (workspaceId: string): void => {
    useWorkspaceStartStore.setState((state) => {
      if (!(workspaceId in state.pending)) return state;
      const { [workspaceId]: _, ...rest } = state.pending;
      return { pending: rest };
    });
  },
};

/** The workspace became ready while this client watched, with this chat. */
export function markStartedIn(workspaceId: string, sessionId: string): void {
  useWorkspaceStartStore.setState((state) =>
    state.startedIn[workspaceId] === sessionId
      ? state
      : { startedIn: { ...state.startedIn, [workspaceId]: sessionId } }
  );
}
