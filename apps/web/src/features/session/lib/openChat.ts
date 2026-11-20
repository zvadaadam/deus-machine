// Open a chat: select its workspace and ask its tab view to show that chat.
// The request, with an identity, waits in a store until that workspace's tab
// view takes it, whether the view is already mounted or mounts now
// (useChatTabs); the view takes exactly that request, once.

import { create } from "zustand";
import { useWorkspaceStore } from "@/features/workspace/store";

export interface OpenChatRequest {
  id: number;
  sessionId: string;
  /** When it was made: a list read before it may not have its chat yet. */
  at: number;
}

interface OpenChatState {
  /** The chat each workspace's tab view is asked to show, until it takes the request. */
  requested: Record<string, OpenChatRequest>;
}

export const useOpenChatStore = create<OpenChatState>(() => ({ requested: {} }));

let next = 0;

export function openChat(workspaceId: string, sessionId: string): void {
  useOpenChatStore.setState((state) => ({
    requested: { ...state.requested, [workspaceId]: { id: ++next, sessionId, at: Date.now() } },
  }));
  useWorkspaceStore.getState().selectWorkspace(workspaceId);
}

/** The tab view takes request `id`: true only if it was still the workspace's request. */
export function openChatDone(workspaceId: string, id: number): boolean {
  const state = useOpenChatStore.getState();
  if (state.requested[workspaceId]?.id !== id) return false;
  const { [workspaceId]: _taken, ...rest } = state.requested;
  useOpenChatStore.setState({ requested: rest });
  return true;
}
