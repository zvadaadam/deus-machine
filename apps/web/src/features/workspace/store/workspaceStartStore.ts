/**
 * What this device knows about the workspaces it watched start.
 *
 * `pending` — the message typed before a workspace existed, waiting for its
 * first chat (delivered by session/hooks/useFirstMessageDelivery). Keyed by
 * workspace, so one workspace becoming ready cannot send another's. It stays
 * until it is delivered: a start that fails keeps it, and a retry of the same
 * workspace sends it. Kept in localStorage, so it outlives the window on this
 * device: a reload, and quitting the app. After a quit the workspace is a
 * failed start (the backend stopped with the app), so the message sends only
 * on a Retry. Where the backend outlives the window (the web app), it sends
 * when the window returns, unless the chat was spoken to first: then it goes
 * to that chat's composer instead (missedFirstMessages).
 *
 * `startedIn` — the chat a workspace started with. That chat tells the story
 * of the start (its steps, its warnings) under its first message, the way a
 * cloud chat keeps its computer's provisioning; later chats, and this one
 * after a reload, do not. It is kept in memory only.
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

/** localStorage that never throws: a message with large images may not fit,
 *  and then it simply is not kept across a reload or a quit. */
const deviceStorage: StateStorage = {
  getItem: (name) => {
    try {
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      localStorage.setItem(name, value);
    } catch {
      // Over quota, or no storage (tests, private windows). Drop the older copy
      // too: restoring it would bring back a message that may have been sent.
      try {
        localStorage.removeItem(name);
      } catch {
        /* no storage */
      }
    }
  },
  removeItem: (name) => {
    try {
      localStorage.removeItem(name);
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
      storage: createJSONStorage(() => deviceStorage),
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
