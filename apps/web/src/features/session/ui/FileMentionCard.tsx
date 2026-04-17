/**
 * FileMentionCard — compact chip shown above the chat textarea
 * when a user picks a file from the @ mention picker.
 *
 * Mirrors InspectedElementCard visually. Shows file icon + filename,
 * with the full relative path available via tooltip (title attr).
 */

import { X, File } from "lucide-react";
import { m } from "framer-motion";

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
    <m.div
      layout
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.15, ease: [0.165, 0.84, 0.44, 1] }}
      title={mention.path}
      className="group bg-primary/8 border-primary/20 relative flex shrink-0 items-center gap-1.5 rounded-full border py-1 pr-1.5 pl-2"
    >
      <File className="text-primary/70 h-3 w-3 shrink-0" />
      <span className="text-foreground/80 max-w-[160px] truncate text-xs">{mention.name}</span>
      <button
        type="button"
        onClick={onRemove}
        className="text-foreground/30 hover:text-foreground/60 ease ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition-colors duration-200"
        aria-label="Remove file mention"
      >
        <X className="h-3 w-3" />
      </button>
    </m.div>
  );
}
