import { forwardRef } from "react";
import { X } from "lucide-react";
import { m, useReducedMotion } from "framer-motion";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
      <Dialog>
        <m.div
          ref={ref}
          layout={!reduceMotion}
          initial={reduceMotion ? false : { opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.2, ease: [0.165, 0.84, 0.44, 1] }}
          className="group relative shrink-0"
        >
          <DialogTrigger asChild>
            <button
              type="button"
              className={cn(
                // Pure black/white outline at 10% opacity (the skill's image rule —
                // never a tinted neutral, which picks up the surface color and
                // reads as dirt on the image edge).
                "focus-visible:ring-ring/60 bg-bg-muted/40 relative block cursor-zoom-in overflow-hidden border border-black/10 transition-transform duration-150 ease-out focus-visible:ring-2 focus-visible:outline-none active:scale-[0.96] dark:border-white/10",
                SIZE_CLASSES[size]
              )}
              aria-label={`Preview image ${fileName}`}
            >
              <img
                src={preview}
                className="h-full w-full object-contain outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
                alt={fileName}
              />
            </button>
          </DialogTrigger>

          <button
            type="button"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onRemove();
            }}
            className="bg-bg-elevated/96 text-muted-foreground hover:bg-bg-muted hover:text-foreground focus-visible:ring-ring/60 absolute -top-1.5 -right-1.5 z-10 flex h-5 w-5 items-center justify-center rounded-full border border-black/10 shadow-sm transition-[transform,opacity,background-color,color] duration-150 ease-out before:absolute before:inset-[-12px] before:content-[''] focus-visible:ring-2 focus-visible:outline-none active:scale-[0.96] sm:pointer-events-none sm:opacity-0 sm:group-focus-within:pointer-events-auto sm:group-focus-within:opacity-100 sm:group-hover:pointer-events-auto sm:group-hover:opacity-100 dark:border-white/10"
            aria-label="Remove attachment"
          >
            <X className="text-muted-foreground h-3 w-3" />
          </button>
        </m.div>

        <DialogContent
          showCloseButton={false}
          className="bg-bg-overlay/96 w-[min(92vw,960px)] max-w-[min(92vw,960px)] gap-2 overflow-hidden rounded-[28px] border-black/10 p-2 shadow-[var(--shadow-elevated)] backdrop-blur-xl dark:border-white/10"
          overlayClassName="bg-bg-overlay/80 backdrop-blur-sm"
        >
          <div className="flex items-start justify-between gap-3 px-3 pt-3">
            <DialogTitle className="min-w-0 flex-1 truncate text-sm leading-snug font-medium">
              {fileName}
            </DialogTitle>
            <DialogClose
              className="focus-visible:ring-ring/60 text-foreground/70 hover:text-foreground hover:bg-bg-muted relative -mt-1 -mr-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-[transform,background-color,color] duration-150 ease-out focus-visible:ring-2 focus-visible:outline-none active:scale-[0.96]"
              aria-label="Close preview"
            >
              <X className="h-4 w-4" />
            </DialogClose>
          </div>
          <div className="bg-bg-muted/80 flex max-h-[78vh] items-center justify-center rounded-[20px] p-2">
            <img
              src={preview}
              alt={fileName}
              className="max-h-[72vh] w-auto max-w-full rounded-[12px] object-contain outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
            />
          </div>
        </DialogContent>
      </Dialog>
    );
  }
);
