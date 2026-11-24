/** Assistant Markdown and the user’s text, inspection references and diff comments. */
import { useCallback, useMemo } from "react";
import { bubbleClass, type BubbleJoins } from "../bubble";
import type { MessageRole } from "@/shared/types";
import type { MarkdownFileLinkResolution } from "@/components/markdown/MarkdownRenderer";

import { ChatMarkdown } from "@/components/markdown";
import { cn } from "@/shared/lib/utils";
import { isBrowserPreviewPath, normalizeResourcePath } from "../../lib/chatResources";
import { openAddressFromChat, openFromChat } from "../../lib/openFromChat";
import { openFile } from "@/features/workspace/lib/reach";
import { parseUserMessageReferences } from "../../lib/parseUserMessageReferences";
import { InspectElementPill } from "../InspectElementPill";
import { DiffCommentPill } from "../DiffCommentPill";
import { useSession } from "../../context";

interface TextBlockProps {
  /** The markdown to render. Every caller holds a string: the engine's
   *  `TextPart.text`, or one of a user message's text parts. */
  block: string;
  role?: MessageRole;
  muted?: boolean;
  bubble?: BubbleJoins;
}

export function TextBlock({
  block: text,
  role = "assistant",
  muted = false,
  bubble,
}: TextBlockProps) {
  const { workspaceId, workspacePath, cloud } = useSession();

  const referenceSegments = useMemo(
    () =>
      role === "user" &&
      (text?.includes("<inspect") ||
        text?.includes("&lt;inspect") ||
        text?.includes("<diff-comment"))
        ? parseUserMessageReferences(text)
        : [],
    [role, text]
  );

  // Where a link or a file opens is rule 2 (features/workspace/lib/reach.ts).
  const handleMarkdownLinkOpen = useCallback(
    async (href: string) => {
      if (!workspaceId) return;
      const url = resolveBrowserLinkUrl(href);
      if (!url) return;
      await openAddressFromChat(workspaceId, url, { cloud, folder: workspacePath });
    },
    [workspaceId, cloud, workspacePath]
  );

  const resolveFileLink = useCallback(
    (href: string): MarkdownFileLinkResolution => {
      const path = getWorkspaceFilePathFromHref(href, workspacePath);
      if (!path) {
        if (/^file:\/\//iu.test(href.trim())) {
          return {
            path: href,
            disabled: true,
            target: "file",
            title: "Only workspace files can be opened",
          };
        }
        return null;
      }

      // A cloud computer's files open in the Files tab (rule 2), not a preview.
      const target = !cloud && isBrowserPreviewPath(path) ? "browser" : "file";
      return {
        path,
        target,
        title: target === "browser" ? `Open preview ${path}` : `Open ${path} in Files`,
      };
    },
    [workspacePath, cloud]
  );

  const handleFileLinkOpen = useCallback(
    async (path: string) => {
      if (!workspaceId) return;
      const place = { cloud, folder: workspacePath };
      await openFromChat(
        workspaceId,
        openFile(path, place, isBrowserPreviewPath(path) ? "preview" : "files")
      );
    },
    [workspaceId, cloud, workspacePath]
  );

  if (!text || text.trim() === "") {
    return null;
  }

  if (role === "user") {
    return (
      <p className="text-foreground text-base font-normal whitespace-pre-wrap">
        {referenceSegments.length
          ? referenceSegments.map((segment, i) => {
              if (segment.type === "text") return <span key={i}>{segment.text}</span>;
              if (segment.type === "diff-comment")
                return <DiffCommentPill key={i} comment={segment.comment} />;
              return <InspectElementPill key={i} element={segment.element} />;
            })
          : text}
      </p>
    );
  }

  return (
    <ChatMarkdown
      className={cn(
        "flex flex-col gap-1.5",
        muted && "opacity-60",
        bubble
          ? cn(
              bubbleClass("assistant", bubble),
              "bg-muted/50 overflow-x-auto [&_table]:break-normal [&_td_code]:wrap-anywhere"
            )
          : "px-2 py-1.5"
      )}
      resolveFileLink={resolveFileLink}
      onFileLinkOpen={handleFileLinkOpen}
      onLinkOpen={handleMarkdownLinkOpen}
    >
      {text}
    </ChatMarkdown>
  );
}

function resolveBrowserLinkUrl(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed || /^(?:#|mailto:|tel:)/iu.test(trimmed)) return null;
  if (/^https?:\/\//iu.test(trimmed)) return trimmed;
  if (/^\/\//u.test(trimmed)) return `https:${trimmed}`;
  if (/^www\./iu.test(trimmed)) return `https://${trimmed}`;
  if (/^(?:localhost|127\.0\.0\.1|\[::1\]):\d+/iu.test(trimmed)) return `http://${trimmed}`;
  return null;
}

function getWorkspaceFilePathFromHref(
  href: string,
  workspacePath: string | null | undefined
): string | null {
  const trimmed = href.trim();
  const path = fileUrlToPath(trimmed) ?? trimmed.replace(/[?#].*$/u, "");
  if (!looksLikeWorkspaceFileHref(path)) return null;
  return normalizeResourcePath(path, workspacePath);
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

function fileUrlToPath(href: string): string | null {
  if (!/^file:\/\//iu.test(href)) return null;

  try {
    const url = new URL(href);
    return decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
}
