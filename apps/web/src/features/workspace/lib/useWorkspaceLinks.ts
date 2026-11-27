import { useCallback } from "react";
import { toast } from "sonner";
import { api } from "@shared/api";
import { getErrorMessage } from "@shared/lib/errors";
import { appHistory } from "@/shared/lib/appHistory";
import { isMobileViewport } from "@/shared/hooks/use-mobile";
import { getRuntimeClient } from "@/platform/ws";
import type { MarkdownFileLinkResolution } from "@/components/markdown/MarkdownRenderer";
import { isBrowserPreviewPath, normalizeResourcePath } from "@/features/session/lib/chatResources";
import {
  chatPlaceNow,
  openAddressFromChat,
  openFromChat,
} from "@/features/session/lib/openFromChat";
import { openFile, localFolder, type ChatPlace } from "./reach";

const boardPlace = { cloud: false, folder: null, fileTab: false };
const outside = "Only files inside this workspace can be opened.";

export function useWorkspaceLinks(
  workspaceId: string | null,
  chat?: Pick<ChatPlace, "cloud" | "folder">
) {
  const fromBoard = !chat;
  const folder = chat?.folder ?? null;
  const cloud = chat?.cloud ?? false;
  const resolveFileLink = useCallback(
    (href: string): MarkdownFileLinkResolution => {
      const trimmed = href.trim();
      const raw = workspaceLinkPath(trimmed);
      if (!raw || !looksLikeWorkspaceFileHref(raw))
        return /^file:\/\//iu.test(trimmed)
          ? { path: trimmed, disabled: true, title: outside }
          : null;
      // Relative links need no workspace lookup. An absolute board link asks for its root only on click.
      const path = fromBoard && absolutePath(raw) ? raw : normalizeResourcePath(raw, folder);
      if (!path)
        return fromBoard || /^file:\/\//iu.test(trimmed)
          ? { path: trimmed, disabled: true, title: outside }
          : null;
      const opening = openFile(
        path,
        { cloud, folder, fileTab: !fromBoard && !isMobileViewport() },
        fileHow(path, fromBoard)
      );
      const target = opening.to === "file-preview" ? "browser" : "file";
      return {
        path,
        target,
        title: target === "browser" ? `Open preview ${path}` : `Open ${path}`,
      };
    },
    [fromBoard, folder, cloud]
  );

  const onFileLinkOpen = useCallback(
    async (path: string) => {
      if (!workspaceId) return;
      const place = fromBoard ? boardPlace : chatPlaceNow(workspaceId, { cloud, folder });
      if (fromBoard && absolutePath(path)) {
        const visit = appHistory().location;
        const runtime = getRuntimeClient();
        try {
          const workspace = await runtime.call(api.workspace, { workspaceId });
          if (
            visit !== appHistory().location ||
            runtime.getState() === "disposed" ||
            runtime.getState() === "revoked"
          )
            return;
          const relative = workspace && normalizeResourcePath(path, localFolder(workspace));
          if (!relative) {
            toast(outside);
            return;
          }
          path = relative;
        } catch (error) {
          if (visit === appHistory().location) toast.error(getErrorMessage(error));
          return;
        }
      }
      await openFromChat(workspaceId, openFile(path, place, fileHow(path, fromBoard)));
    },
    [workspaceId, fromBoard, folder, cloud]
  );

  const onLinkOpen = useCallback(
    async (href: string) => {
      const url = resolveBrowserLinkUrl(href);
      if (workspaceId && url) await openAddressFromChat(workspaceId, url, { cloud, folder });
    },
    [workspaceId, cloud, folder]
  );
  return { resolveFileLink, onFileLinkOpen, onLinkOpen: fromBoard ? undefined : onLinkOpen };
}

const absolutePath = (path: string) => /^(?:[A-Za-z]:[\\/]|[\\/])/u.test(path);

function resolveBrowserLinkUrl(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed || /^(?:#|mailto:|tel:)/iu.test(trimmed)) return null;
  if (/^https?:\/\//iu.test(trimmed)) return trimmed;
  if (/^\/\//u.test(trimmed)) return `https:${trimmed}`;
  if (/^www\./iu.test(trimmed)) return `https://${trimmed}`;
  if (/^(?:localhost|127\.0\.0\.1|\[::1\]):\d+/iu.test(trimmed)) return `http://${trimmed}`;
  return null;
}

function looksLikeWorkspaceFileHref(href: string): boolean {
  if (!href || /^(?:#|mailto:|tel:)/iu.test(href)) return false;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|www\.)/iu.test(href)) return false;

  return (
    href.startsWith("./") ||
    href.startsWith("../") ||
    href.includes("/") ||
    /\.[^/.?#]+(?:[?#].*)?$/u.test(href)
  );
}

const fileHow = (path: string, fromBoard: boolean) =>
  !fromBoard && isBrowserPreviewPath(path) ? "preview" : "files";

function workspaceLinkPath(href: string): string | null {
  const fileUrl = /^file:\/\//iu.test(href);
  try {
    if (!fileUrl) return decodeURIComponent(href.replace(/[?#].*$/u, ""));
    const url = new URL(href);
    return url.hostname ? null : decodeURIComponent(url.pathname);
  } catch {
    return fileUrl ? null : href;
  }
}
