/**
 * FileMentionCard — chip shown above the chat textarea when a user picks
 * a file from the @ mention picker. Uses the shared <MentionChip>
 * primitive with the primary (blue) tone. Shows filename in the chip
 * and full relative path in the hover tooltip.
 */

import { File } from "lucide-react";
import { MentionChip } from "@/components/ui/mention-chip";

export interface FileMention {
  id: string;
  /** Workspace-relative path, e.g. "apps/web/src/foo.ts" */
  path: string;
  /** Filename only, e.g. "foo.ts" */
  name: string;
}

interface FileMentionCardProps {
  mention: FileMention;
  onRemove: () => void;
}

export function FileMentionCard({ mention, onRemove }: FileMentionCardProps) {
  return (
    <MentionChip
      icon={File}
      title={mention.path}
      onRemove={onRemove}
      removeAriaLabel={`Remove file mention ${mention.name}`}
    >
      <span className="text-foreground/80 max-w-[160px] truncate text-xs">{mention.name}</span>
    </MentionChip>
  );
}
