import { createBrowserHistory } from "@tanstack/react-router";
import { useSyncExternalStore } from "react";
import { isWorkspaceLinkId } from "@shared/workspace-link";
import { capabilities } from "@/platform/capabilities";
import { getServerIdFromUrl } from "@/shared/config/backend.config";
import { workspaceAddress, workspaceChatId } from "@/features/workspace/lib/workspaceAddress";
import { uiActions } from "@/shared/stores/uiStore";

let history: ReturnType<typeof createBrowserHistory> | undefined;
export const appHistory = () => (history ??= createBrowserHistory());

export interface BoardLink {
  boardId: string;
  thread?: number;
}

export function boardSearch(search: Record<string, unknown>): { thread?: number } {
  const n = Number(search.thread);
  return Number.isSafeInteger(n) && n > 0 && String(n) === String(search.thread)
    ? { thread: n }
    : {};
}

export function boardAddress({ boardId, thread }: BoardLink) {
  const server = getServerIdFromUrl();
  return `${server ? "/s/" + encodeURIComponent(server) : ""}/b/${encodeURIComponent(boardId)}${thread ? "?thread=" + thread : ""}`;
}

export function openBoard(boardId: string, thread?: number) {
  uiActions.closeAllModals();
  const href = boardAddress({ boardId, thread });
  if (appHistory().location.href !== href) appHistory().push(href);
}

function readAddress(href: string): BoardLink | undefined {
  const url = new URL(href, "https://localhost");
  const boardId = /^(?:\/s\/[^/]+)?\/b\/([^/]+)\/?$/.exec(url.pathname)?.[1];
  if (!isWorkspaceLinkId(boardId)) return;
  return { boardId, ...boardSearch(Object.fromEntries(url.searchParams)) };
}

const listen = (notify: () => void) => appHistory().subscribe(notify);
const current = () => appHistory().location.href;
export function useBoardAddress() {
  return readAddress(useSyncExternalStore(listen, current, () => "/"));
}

/** Home can already be selected behind a board, including in the desktop’s single window. */
export function leaveBoard(workspaceId?: string) {
  if (
    typeof window === "undefined" ||
    !window.location?.pathname.includes("/b/") ||
    !readAddress(appHistory().location.href)
  )
    return;
  const server = getServerIdFromUrl();
  const workspace = capabilities.singleWindow ? undefined : workspaceId;
  appHistory().push(workspaceAddress(server, workspace, workspaceChatId(workspace)));
}
