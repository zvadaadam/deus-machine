/**
 * Inline edit form wrapper — animates height to auto on mount,
 * collapses on unmount via AnimatePresence (must be wrapped externally).
 *
 * Category views provide form fields as children.
 * Save / Cancel buttons are built in.
 */

import { type ReactNode } from "react";
import { m, useReducedMotion } from "framer-motion";
import { Button } from "@/components/ui/button";

interface ConfigItemExpandedProps {
  children: ReactNode;
  onSave: () => void;
  onCancel: () => void;
  isSaving?: boolean;
  saveLabel?: string;
}

export function ConfigItemExpanded({
  children,
  onSave,
  onCancel,
  isSaving = false,
  saveLabel = "Save",
}: ConfigItemExpandedProps) {
  const reduced = useReducedMotion();
  const transition = reduced
    ? { duration: 0 }
    : { duration: 0.2, ease: [0.165, 0.84, 0.44, 1] as const };

  return (
    <m.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: "auto", opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={transition}
      className="overflow-hidden"
    >
      <div className="bg-muted/10 border-border/40 space-y-3 border-b p-4 last:border-b-0">
        {children}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-3 text-xs"
            onClick={onCancel}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button size="sm" className="h-7 px-3 text-xs" onClick={onSave} disabled={isSaving}>
            {isSaving ? "Saving..." : saveLabel}
          </Button>
        </div>
      </div>
    </m.div>
  );
}
