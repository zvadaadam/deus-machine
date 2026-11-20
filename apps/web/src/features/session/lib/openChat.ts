// Open a chat: select its workspace and ask its tab view to show that chat.
// The request, with an identity, waits in a store until that workspace's tab
// view takes it, whether the view is already mounted or mounts now
// (useChatTabs); the view takes exactly that request, once.

import { create } from "zustand";
import { useWorkspaceStore } from "@/features/workspace/store";

export interface OpenChatRequest {
  id: number;
  sessionId: string;
}

interface OpenChatState {
  /** The chat each workspace's tab view is asked to show, until it takes the request. */
  requested: Record<string, OpenChatRequest>;
}

export const useOpenChatStore = create<OpenChatState>(() => ({ requested: {} }));

let next = 0;

export function openChat(workspaceId: string, sessionId: string): void {
  useOpenChatStore.setState((state) => ({
    requested: { ...state.requested, [workspaceId]: { id: ++next, sessionId } },
  }));
  useWorkspaceStore.getState().selectWorkspace(workspaceId);
}

/** The tab view took request `id`; a newer request for the workspace stays. */
export function openChatDone(workspaceId: string, id: number): void {
  useOpenChatStore.setState((state) => {
    if (state.requested[workspaceId]?.id !== id) return state;
    const { [workspaceId]: _taken, ...rest } = state.requested;
    return { requested: rest };
  });
}
