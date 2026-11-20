// Open a chat: select its workspace and ask its tab view to show that chat.
// The request waits in a store until the workspace's tab view consumes it,
// whether that view is already mounted or mounts now (useChatTabs).

import { create } from "zustand";
import { useWorkspaceStore } from "@/features/workspace/store";

interface OpenChatState {
  /** The chat each workspace's tab view is asked to show, until it does. */
  requested: Record<string, string>;
}

export const useOpenChatStore = create<OpenChatState>(() => ({ requested: {} }));

export function openChat(workspaceId: string, sessionId: string): void {
  useOpenChatStore.setState((state) => ({
    requested: { ...state.requested, [workspaceId]: sessionId },
  }));
  useWorkspaceStore.getState().selectWorkspace(workspaceId);
}

/** The tab view took the request. */
export function openChatDone(workspaceId: string): void {
  useOpenChatStore.setState((state) => {
    const { [workspaceId]: _done, ...rest } = state.requested;
    return { requested: rest };
  });
}
