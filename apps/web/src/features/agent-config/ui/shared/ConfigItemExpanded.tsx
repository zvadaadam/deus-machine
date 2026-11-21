/**
 * Inline edit form wrapper — animates height to auto on mount,
 * collapses on unmount via AnimatePresence (must be wrapped externally).
 *
 * Category views provide form fields as children.
 * Save / Cancel buttons are built in.
 */

import { Collapse } from "@/components/ui/collapse";
import { type ReactNode } from "react";
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
  return (
    <Collapse>
      <div className="bg-muted/10 border-border/40 space-y-3 border-b p-4 last:border-b-0">
        {children}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="ghost" size="xs" className="px-3" onClick={onCancel} disabled={isSaving}>
            Cancel
          </Button>
          <Button size="xs" className="px-3" onClick={onSave} disabled={isSaving}>
            {isSaving ? "Saving..." : saveLabel}
          </Button>
        </div>
      </div>
    </Collapse>
  );
}
