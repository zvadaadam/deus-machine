import { X } from "lucide-react";
import { m, useReducedMotion } from "framer-motion";
import { Badge } from "@/components/ui/badge";

interface PastedTextCardProps {
  content: string;
  onRemove: () => void;
}

export function PastedTextCard({ content, onRemove }: PastedTextCardProps) {
  const reduceMotion = useReducedMotion();
  return (
    <m.div
      layout={!reduceMotion}
      initial={reduceMotion ? false : { opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.2, ease: [0.165, 0.84, 0.44, 1] }}
      className="group bg-muted/50 border-border/60 relative flex h-[80px] w-44 shrink-0 flex-col rounded-md border p-2"
    >
      <p className="text-foreground/60 text-2xs line-clamp-3 min-h-0 flex-1 font-mono leading-snug">
        {content}
      </p>
      <div className="mt-1">
        <Badge
          variant="secondary"
          className="text-2xs rounded-md px-1.5 py-0 font-semibold tracking-wider uppercase"
        >
          Pasted
        </Badge>
      </div>
      {/* Remove button — appears on hover */}
      <button
        onClick={onRemove}
        className="bg-bg-elevated border-border/40 ease absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full border opacity-0 shadow-sm transition-opacity duration-200 group-hover:opacity-100 before:absolute before:inset-[-12px] before:content-[''] focus-visible:opacity-100"
        aria-label="Remove pasted text"
      >
        <X className="text-muted-foreground h-3 w-3" />
      </button>
    </m.div>
  );
}
