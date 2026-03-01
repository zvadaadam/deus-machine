/**
 * Compact item row for config items (collapsed state).
 *
 * Displays name, description, and inline hover-reveal action icons.
 * 36-48px height, single-line truncated description.
 */

import { memo } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { Button } from "@/components/ui/button";
import type { ConfigDisplayItem } from "../../types";

interface ConfigItemRowProps {
  item: ConfigDisplayItem;
  onEdit?: (item: ConfigDisplayItem) => void;
  onDelete?: (item: ConfigDisplayItem) => void;
}

export const ConfigItemRow = memo(function ConfigItemRow({
  item,
  onEdit,
  onDelete,
}: ConfigItemRowProps) {
  return (
    <div className="group border-border/40 flex items-center justify-between gap-3 border-b px-3 py-2 last:border-b-0">
      <div
        className={cn("min-w-0 flex-1", onEdit && "cursor-pointer")}
        onClick={onEdit ? () => onEdit(item) : undefined}
      >
        <p className="text-foreground truncate text-[13px] font-medium">{item.name}</p>
        {item.description && (
          <p className="text-muted-foreground truncate text-xs">{item.description}</p>
        )}
      </div>

      {(onEdit || onDelete) && (
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
          {onEdit && (
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground h-7 w-7"
              onClick={() => onEdit(item)}
              aria-label={`Edit ${item.name}`}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          )}
          {onDelete && (
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-destructive h-7 w-7"
              onClick={() => onDelete(item)}
              aria-label={`Delete ${item.name}`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
});
