/**
 * Undo strip — shown for 4 seconds after deleting an item.
 *
 * Uses AnimatePresence + m (LazyMotion strict) for enter/exit transitions.
 * If the user doesn't click Undo, the actual delete fires after the timer.
 */

import { tempo } from "@/shared/lib/tempo";
import { useEffect, useRef, useCallback } from "react";
import { m } from "framer-motion";
import { Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface UndoStripProps {
  itemName: string;
  onUndo: () => void;
  onExpire: () => void;
  duration?: number;
}

export function UndoStrip({ itemName, onUndo, onExpire, duration = 4000 }: UndoStripProps) {
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
      exit={{ opacity: 0, y: 6, transition: tempo.moderate.exit }}
      transition={tempo.moderate}
      className="bg-muted border-border/40 flex items-center justify-between rounded-lg border px-3 py-2"
    >
      <span className="text-muted-foreground text-xs">
        Deleted <span className="text-foreground font-medium">{itemName}</span>
      </span>
      <Button variant="ghost" size="sm" className="h-6 gap-1 px-2" onClick={handleUndo}>
        <Undo2 className="h-3 w-3" />
        Undo
      </Button>
    </m.div>
  );
}
