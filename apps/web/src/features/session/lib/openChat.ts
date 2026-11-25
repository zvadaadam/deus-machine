// Open a chat: select its workspace and ask its tab view to show that chat.
// The request, with an identity, waits in a store until that workspace's tab
// view takes it, whether the view is already mounted or mounts now
// (useChatTabs); the view takes exactly that request, once.

import { create } from "zustand";
import { useSession } from "../context";
import { showWorkspace } from "@/features/workspace/lib/openWorkspace";
import { workspaceLayoutActions } from "@/features/workspace/store";

export interface OpenChatRequest {
  id: number;
  sessionId: string;
  /** When it was made: a list read before it may not have its chat yet. */
  at: number;
}

interface OpenChatState {
  /** The chat each workspace's tab view is asked to show, until it takes the request. */
  requested: Record<string, OpenChatRequest>;
  transcriptFolds: Record<string, boolean | undefined>;
}

export const useOpenChatStore = create<OpenChatState>(() => ({
  requested: {},
  transcriptFolds: {},
}));

export function useTranscriptFold(
  kind: "worked" | "activity" | "thought" | "agent" | "tool" | "message",
  id: string | undefined,
  defaultOpen = false
) {
  const { sessionId } = useSession();
  const key = JSON.stringify([sessionId, kind, id]);
  const stored = useOpenChatStore((state) => state.transcriptFolds[key]);
  const expanded = stored ?? defaultOpen;
  function toggle() {
    useOpenChatStore.setState(({ transcriptFolds }) => ({
      transcriptFolds: { ...transcriptFolds, [key]: !expanded },
    }));
  }
  return [expanded, toggle, stored !== undefined] as const;
}

let next = 0;
const OPEN_CHAT_REQUEST_MAX_AGE_MS = 10_000;

/** An old request must not move focus when a workspace opens later. */
export function currentOpenChatRequest(workspaceId: string): OpenChatRequest | undefined {
  const request = useOpenChatStore.getState().requested[workspaceId];
  return request && Date.now() - request.at <= OPEN_CHAT_REQUEST_MAX_AGE_MS ? request : undefined;
}

export function openChat(workspaceId: string, sessionId: string): void {
  useOpenChatStore.setState((state) => ({
    requested: { ...state.requested, [workspaceId]: { id: ++next, sessionId, at: Date.now() } },
  }));
  if (workspaceLayoutActions.getLayout(workspaceId).panelMode === "content") {
    workspaceLayoutActions.setPanelMode(workspaceId, "split");
  }
  showWorkspace(workspaceId);
}

/** The tab view takes request `id`: true only if it was still the workspace's request. */
export function openChatDone(workspaceId: string, id: number): boolean {
  const state = useOpenChatStore.getState();
  if (state.requested[workspaceId]?.id !== id) return false;
  const { [workspaceId]: _taken, ...rest } = state.requested;
  useOpenChatStore.setState({ requested: rest });
  return true;
}
