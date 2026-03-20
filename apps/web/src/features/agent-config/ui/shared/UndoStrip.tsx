/**
 * Undo strip — shown for 4 seconds after deleting an item.
 *
 * Uses AnimatePresence + m (LazyMotion strict) for enter/exit transitions.
 * If the user doesn't click Undo, the actual delete fires after the timer.
 */

import { useEffect, useRef, useCallback } from "react";
import { m, useReducedMotion } from "framer-motion";
import { Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface UndoStripProps {
  itemName: string;
  onUndo: () => void;
  onExpire: () => void;
  duration?: number;
}

export function UndoStrip({ itemName, onUndo, onExpire, duration = 4000 }: UndoStripProps) {
  const reduced = useReducedMotion();
  const transition = reduced
    ? { duration: 0 }
    : { duration: 0.2, ease: [0.165, 0.84, 0.44, 1] as const };

  // Timer ref so we can cancel it when Undo is clicked.
  // AnimatePresence keeps this component mounted during exit animation,
  // so the timer would fire even after the user clicks Undo.
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    timerRef.current = setTimeout(onExpire, duration);
    return () => clearTimeout(timerRef.current);
  }, [onExpire, duration]);

  const handleUndo = useCallback(() => {
    clearTimeout(timerRef.current);
    onUndo();
  }, [onUndo]);

  return (
    <m.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      transition={transition}
      className="bg-muted border-border/40 flex items-center justify-between rounded-lg border px-3 py-2"
    >
      <span className="text-muted-foreground text-xs">
        Deleted <span className="text-foreground font-medium">{itemName}</span>
      </span>
      <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-xs" onClick={handleUndo}>
        <Undo2 className="h-3 w-3" />
        Undo
      </Button>
    </m.div>
  );
}
