import { forwardRef } from "react";
import { X } from "lucide-react";
import { m, useReducedMotion } from "framer-motion";
import { cn } from "@/shared/lib/utils";

const SIZE_CLASSES = {
  sm: "h-14 w-14 rounded-md",
  md: "h-[80px] w-[80px] rounded-lg",
} as const;

interface PastedImageCardProps {
  preview: string;
  fileName: string;
  onRemove: () => void;
  /** sm = 56px (compact inputs), md = 80px (session chat). Default: md */
  size?: keyof typeof SIZE_CLASSES;
}

export const PastedImageCard = forwardRef<HTMLDivElement, PastedImageCardProps>(
  function PastedImageCard({ preview, fileName, onRemove, size = "md" }, ref) {
    const reduceMotion = useReducedMotion();
    return (
      <m.div
        ref={ref}
        layout={!reduceMotion}
        initial={reduceMotion ? false : { opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.95 }}
        transition={{ duration: 0.2, ease: [0.165, 0.84, 0.44, 1] }}
        className={cn(
          // Pure black/white outline at 10% opacity (the skill's image rule —
          // never a tinted neutral, which picks up the surface color and
          // reads as dirt on the image edge).
          "group bg-muted/50 relative shrink-0 overflow-hidden border border-black/10 dark:border-white/10",
          SIZE_CLASSES[size]
        )}
      >
        <img src={preview} className="h-full w-full object-cover" alt={fileName} />
        <button
          onClick={onRemove}
          className="absolute top-1 right-1 flex h-4 w-4 items-center justify-center rounded-full bg-black/50 text-white/80 opacity-0 backdrop-blur-sm transition-opacity duration-150 group-hover:opacity-100 hover:bg-black/70 hover:text-white focus-visible:opacity-100"
          aria-label="Remove attachment"
        >
          <X className="h-2.5 w-2.5" />
        </button>
      </m.div>
    );
  }
);
