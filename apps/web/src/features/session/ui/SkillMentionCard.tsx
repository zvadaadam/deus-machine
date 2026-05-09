/**
 * SkillMentionCard — chip shown above the chat textarea when a user
 * picks a skill from the / slash command picker. Uses the shared
 * <MentionChip> primitive with the warning (orange) tone to visually
 * distinguish skills from inspect/file pills (primary/blue).
 */

import { Sparkles } from "lucide-react";
import { MentionChip } from "@/components/ui/mention-chip";

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
    <MentionChip
      tone="warning"
      icon={Sparkles}
      title={mention.description ?? mention.name}
      onRemove={onRemove}
      removeAriaLabel={`Remove skill ${mention.name}`}
    >
      <span className="text-foreground/80 max-w-[160px] truncate text-xs">{mention.name}</span>
    </MentionChip>
  );
}
