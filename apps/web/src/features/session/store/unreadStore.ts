/**
 * Tracks sessions with unseen activity (agent finished while user wasn't looking).
 * Persisted to localStorage so indicators survive app restarts.
 */

import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";

interface UnreadStore {
  /** Set of session IDs with unseen activity */
  unreadSessionIds: Record<string, true>;

  seenBoards: Record<string, number>;
  seeBoard: (id: string, seq: number) => void;

  /** Mark a session as having unseen activity */
  markUnread: (sessionId: string) => void;

  /** Mark a session as read (user viewed it) */
  markRead: (sessionId: string) => void;
}

export const useUnreadStore = create<UnreadStore>()(
  devtools(
    persist(
      (set) => ({
        unreadSessionIds: {},
        seenBoards: {},
        seeBoard: (id, seq) =>
          set((state) =>
            (state.seenBoards[id] ?? 0) >= seq
              ? state
              : {
                  seenBoards: { ...state.seenBoards, [id]: seq },
                }
          ),

        markUnread: (sessionId) =>
          set(
            (state) => ({
              unreadSessionIds: { ...state.unreadSessionIds, [sessionId]: true as const },
            }),
            false,
            "unread/markUnread"
          ),

        markRead: (sessionId) =>
          set(
            (state) => {
              if (!state.unreadSessionIds[sessionId]) return state;
              const { [sessionId]: _, ...rest } = state.unreadSessionIds;
              return { unreadSessionIds: rest };
            },
            false,
            "unread/markRead"
          ),
      }),
      {
        name: "unread-sessions-store",
        version: 1,
      }
    ),
    {
      name: "unread-sessions-store",
      enabled: import.meta.env.DEV,
    }
  )
);

export const unreadActions = {
  markUnread: (sessionId: string) => useUnreadStore.getState().markUnread(sessionId),
  markRead: (sessionId: string) => useUnreadStore.getState().markRead(sessionId),
};
