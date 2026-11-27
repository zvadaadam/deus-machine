import { useCallback, type ComponentProps, type ReactNode } from "react";
import { ChatMarkdown } from "@/components/markdown";
import type { MarkdownFileLink } from "@/components/markdown/MarkdownRenderer";
import { LabelPill } from "@/components/ui/label-pill";
import { PierreFileIcon } from "@/features/file-browser/lib/pierreIcons";
import { useWorkspaceLinks } from "@/features/workspace/lib/useWorkspaceLinks";

export function BoardMarkdown({
  workspaceId,
  ...props
}: Pick<ComponentProps<typeof ChatMarkdown>, "children" | "className" | "transformText"> & {
  workspaceId: string;
}) {
  const { resolveFileLink, onFileLinkOpen } = useWorkspaceLinks(workspaceId);
  const renderLink = useCallback(
    (href: string, children: ReactNode) => {
      const file = resolveFileLink(href);
      return file ? (
        <BoardFileChip link={file} onOpen={onFileLinkOpen} />
      ) : (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      );
    },
    [resolveFileLink, onFileLinkOpen]
  );
  return <ChatMarkdown {...props} renderLink={renderLink} />;
}

function BoardFileChip({
  link,
  onOpen,
}: {
  link: MarkdownFileLink;
  onOpen: (path: string) => void;
}) {
  const slash = link.path.lastIndexOf("/");
  const name = link.path.slice(slash + 1) || link.path;
  return (
    <LabelPill asChild>
      <button
        type="button"
        disabled={link.disabled}
        title={link.title}
        className="relative align-middle disabled:opacity-60 pointer-coarse:after:absolute pointer-coarse:after:-inset-y-2"
        onClick={() => onOpen(link.path)}
      >
        <PierreFileIcon fileName={name} />
        <span>{name}</span>
        {slash > 0 && <span className="text-text-muted text-xs">{link.path.slice(0, slash)}</span>}
      </button>
    </LabelPill>
  );
}
