/** Assistant Markdown and the user’s text, inspection references and diff comments. */
import { useMemo } from "react";
import { bubbleClass, type BubbleJoins } from "../bubble";
import type { MessageRole } from "@/shared/types";
import { useWorkspaceLinks } from "@/features/workspace/lib/useWorkspaceLinks";
import { ChatMarkdown } from "@/components/markdown";
import { cn } from "@/shared/lib/utils";
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

  const links = useWorkspaceLinks(workspaceId, { cloud, folder: workspacePath });

  if (!text || text.trim() === "") {
    return null;
  }

  if (role === "user") {
    return (
      <p className="text-foreground text-base font-normal wrap-anywhere whitespace-pre-wrap">
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
              "bg-agent-bubble overflow-x-auto [&_table]:break-normal [&_td_code]:wrap-anywhere"
            )
          : "px-2 py-1.5"
      )}
      {...links}
    >
      {text}
    </ChatMarkdown>
  );
}
