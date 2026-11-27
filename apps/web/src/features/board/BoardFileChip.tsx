import type { MarkdownFileLink } from "@/components/markdown/MarkdownRenderer";
import { LabelPill } from "@/components/ui/label-pill";
import { PierreFileIcon } from "@/features/file-browser/lib/pierreIcons";

export function BoardFileChip({
  link,
  onOpen,
}: {
  link: MarkdownFileLink;
  onOpen: (path: string) => void;
}) {
  const slash = link.path.lastIndexOf("/");
  const name = link.path.slice(slash + 1);
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
