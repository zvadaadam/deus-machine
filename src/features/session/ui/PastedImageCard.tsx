import { X } from "lucide-react";
import { m, useReducedMotion } from "framer-motion";

interface PastedImageCardProps {
  preview: string;
  fileName: string;
  onRemove: () => void;
}

export function PastedImageCard({ preview, fileName, onRemove }: PastedImageCardProps) {
  const reduceMotion = useReducedMotion();
  return (
    <m.div
      layout={!reduceMotion}
      initial={reduceMotion ? false : { opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.2, ease: [0.165, 0.84, 0.44, 1] }}
      className="group bg-muted/50 border-border/60 relative h-[80px] w-[80px] shrink-0 overflow-hidden rounded-lg border"
    >
      <img src={preview} className="h-full w-full object-cover" alt={fileName} />
      <button
        onClick={onRemove}
        className="bg-bg-elevated border-border/40 ease absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full border opacity-0 shadow-sm transition-opacity duration-200 group-hover:opacity-100 focus-visible:opacity-100 before:absolute before:inset-[-12px] before:content-['']"
        aria-label="Remove attachment"
      >
        <X className="text-muted-foreground h-3 w-3" />
      </button>
    </m.div>
  );
}
