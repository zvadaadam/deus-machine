/**
 * MentionChip — shared primitive for staged-content chips above the
 * composer (skill mentions, file mentions, inspected elements).
 *
 * Layout: [icon] [label children] [×]. Tinted translucent pill with a 1px
 * tinted border. Animated enter/exit via framer-motion (every callsite
 * uses the same `layout + scale 0.95→1 + opacity` config — baked in here).
 *
 * Tone drives the bg/border/icon color triad. Caller renders the label
 * children — the simple case is one truncating span, but Inspected uses
 * two spans (tag prefix + identifier).
 */

import type { ComponentType, ReactNode } from "react";
import { X } from "lucide-react";
import { m } from "framer-motion";
import { cn } from "@/shared/lib/utils";

const TONE_CLASSES = {
  primary: {
    bg: "bg-primary/8",
    border: "border-primary/20",
    icon: "text-primary/70",
  },
  warning: {
    bg: "bg-warning/8",
    border: "border-warning/20",
    icon: "text-warning/70",
  },
} as const;

type Tone = keyof typeof TONE_CLASSES;

interface MentionChipProps {
  /** Color theme — drives bg, border, and icon tint. Default: "primary". */
  tone?: Tone;
  /** Icon component (lucide-compatible — accepts className). */
  icon: ComponentType<{ className?: string }>;
  /** Native title attribute — used as the hover tooltip for full text. */
  title?: string;
  /** Click handler for the X close button. */
  onRemove: () => void;
  /** ARIA label for the close button. */
  removeAriaLabel: string;
  /** Label content. Caller renders truncating spans (allows multi-part
   *  labels like Inspected's `<tag>` prefix + identifier). */
  children: ReactNode;
}

export function MentionChip({
  tone = "primary",
  icon: Icon,
  title,
  onRemove,
  removeAriaLabel,
  children,
}: MentionChipProps) {
  const toneClasses = TONE_CLASSES[tone];
  return (
    <m.div
      layout
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.15, ease: [0.165, 0.84, 0.44, 1] }}
      title={title}
      className={cn(
        "group relative flex shrink-0 items-center gap-1.5 rounded-full border py-1 pr-1.5 pl-2",
        toneClasses.bg,
        toneClasses.border
      )}
    >
      <Icon className={cn("h-3 w-3 shrink-0", toneClasses.icon)} />
      {children}
      <button
        type="button"
        onClick={onRemove}
        aria-label={removeAriaLabel}
        className="text-foreground/30 hover:text-foreground/60 ml-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition-colors duration-200"
      >
        <X className="h-3 w-3" />
      </button>
    </m.div>
  );
}
