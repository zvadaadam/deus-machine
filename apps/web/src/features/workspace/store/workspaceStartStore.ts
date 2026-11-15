/**
 * What this client knows about the workspaces it watched start. None of it
 * outlives the window.
 *
 * `pending` — the message typed before a workspace existed, waiting for its
 * first chat (delivered by session/hooks/useFirstMessageDelivery). Keyed by
 * workspace, so one workspace becoming ready cannot send another's. It stays
 * until it is delivered: a start that fails keeps it, and a retry of the same
 * workspace sends it. Kept in sessionStorage, so reloading the window while a
 * workspace starts does not lose it; not in localStorage, where it would send
 * itself hours later, unasked, the next time the app opened.
 *
 * `startedIn` — the chat a workspace started with. That chat tells the story
 * of the start (its steps, its warnings) under its first message, the way a
 * cloud chat keeps its computer's provisioning; later chats, and this one
 * after a reload, do not.
 */
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { ThinkingLevel } from "@/shared/agents";

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

/** sessionStorage that never throws: a message with large images may not fit,
 *  and then it simply is not kept across a reload. */
const windowStorage: StateStorage = {
  getItem: (name) => {
    try {
      return sessionStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      sessionStorage.setItem(name, value);
    } catch {
      /* over quota, or no storage (tests, private windows) */
    }
  },
  removeItem: (name) => {
    try {
      sessionStorage.removeItem(name);
    } catch {
      /* nothing to remove */
    }
  },
};

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
