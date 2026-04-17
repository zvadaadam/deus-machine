/**
 * SkillMentionCard — compact chip shown above the chat textarea
 * when a user picks a skill from the / slash command picker.
 *
 * Uses the "warning" (orange) token to visually distinguish skills
 * from inspect/file pills which use the primary (blue) token.
 */

import { X, Sparkles } from "lucide-react";
import { m } from "framer-motion";

export interface SkillMention {
  id: string;
  /** Skill name (e.g. "code-review") — serializes back as `/<name>` on send */
  name: string;
  description?: string;
}

interface SkillMentionCardProps {
  mention: SkillMention;
  onRemove: () => void;
}

export function SkillMentionCard({ mention, onRemove }: SkillMentionCardProps) {
  return (
    <m.div
      layout
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.15, ease: [0.165, 0.84, 0.44, 1] }}
      title={mention.description ?? mention.name}
      className="group bg-warning/8 border-warning/20 relative flex shrink-0 items-center gap-1.5 rounded-full border py-1 pr-1.5 pl-2"
    >
      <Sparkles className="text-warning/70 h-3 w-3 shrink-0" />
      <span className="text-foreground/80 max-w-[160px] truncate text-xs">{mention.name}</span>
      <button
        type="button"
        onClick={onRemove}
        className="text-foreground/30 hover:text-foreground/60 ease ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition-colors duration-200"
        aria-label="Remove skill"
      >
        <X className="h-3 w-3" />
      </button>
    </m.div>
  );
}
