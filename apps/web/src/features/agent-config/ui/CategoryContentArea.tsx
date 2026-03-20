/**
 * Category content area — renders the header, scope sections, and item list
 * for the currently active config category.
 *
 * Both scopes are always visible: project items first (labeled with repo name),
 * then global items below (dimmed at the card level).
 * When no repoPath is set, only global items are shown at full opacity.
 * When project scope is active but empty, an empty state is shown.
 *
 * CRUD support: category views pass editingItem / addingInScope / pendingDeleteItem
 * along with a renderEditForm render-prop. This component handles placement of
 * the edit form inline, undo strips, and scope section layout.
 */

import type { ReactNode } from "react";
import { AnimatePresence } from "framer-motion";
import { Plus, FolderGit2, Globe } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfigItemRow } from "./shared/ConfigItemRow";
import { EmptyState } from "./shared/EmptyState";
import { UndoStrip } from "./shared/UndoStrip";
import type { ConfigDisplayItem, ConfigScope } from "../types";

interface CategoryContentAreaProps {
  categoryLabel: string;
  globalItems: ConfigDisplayItem[];
  projectItems: ConfigDisplayItem[];
  repoName?: string;
  repoPath?: string;
  isLoading?: boolean;
  onAdd?: (scope: ConfigScope) => void;
  onEdit?: (item: ConfigDisplayItem) => void;
  onDelete?: (item: ConfigDisplayItem) => void;

  /** The item currently being edited inline (null = nothing editing) */
  editingItem?: ConfigDisplayItem | null;
  /** Which scope section shows the "add new" form (null = not adding) */
  addingInScope?: ConfigScope | null;
  /** Category views provide form content via this render prop. Cancel is owned by the form itself. */
  renderEditForm?: (item: ConfigDisplayItem | null) => ReactNode;
  /** Item awaiting delete (hidden from list, undo strip shown) */
  pendingDeleteItem?: ConfigDisplayItem | null;
  onUndoDelete?: () => void;
  onConfirmDelete?: () => void;
}

export function CategoryContentArea({
  categoryLabel,
  globalItems,
  projectItems,
  repoName,
  repoPath,
  isLoading,
  onAdd,
  onEdit,
  onDelete,
  editingItem,
  addingInScope,
  renderEditForm,
  pendingDeleteItem,
  onUndoDelete,
  onConfirmDelete,
}: CategoryContentAreaProps) {
  // Both scopes always visible; global dimmed only when project scope is active
  const hasProjectScope = !!repoPath;
  const dimGlobal = hasProjectScope;

  // Filter out the pending-delete item so it disappears instantly
  const visibleProjectItems =
    pendingDeleteItem?.scope === "project"
      ? projectItems.filter((i) => i.id !== pendingDeleteItem.id)
      : projectItems;
  const visibleGlobalItems =
    pendingDeleteItem?.scope === "global"
      ? globalItems.filter((i) => i.id !== pendingDeleteItem.id)
      : globalItems;

  const hasGlobalContent = visibleGlobalItems.length > 0 || addingInScope === "global";
  // Project section always visible when scope exists; top-level empty only when nothing at all
  const hasAnyContent = hasProjectScope || hasGlobalContent || pendingDeleteItem != null;

  const isEditingItem = (item: ConfigDisplayItem) =>
    editingItem != null && editingItem.id === item.id && editingItem.scope === item.scope;

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      {/* Category header */}
      <div className="border-border/40 flex h-10 shrink-0 items-center justify-between border-b px-4">
        <h2 className="text-sm font-medium">{categoryLabel}</h2>
        {onAdd &&
          !addingInScope &&
          !editingItem &&
          !pendingDeleteItem &&
          (hasProjectScope ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs">
                  <Plus className="h-3.5 w-3.5" />
                  Add
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onAdd("project")}>
                  <FolderGit2 className="h-3.5 w-3.5" />
                  Add to {repoName ?? "Project"}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onAdd("global")}>
                  <Globe className="h-3.5 w-3.5" />
                  Add to Global
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              onClick={() => onAdd("global")}
            >
              <Plus className="h-3.5 w-3.5" />
              Add
            </Button>
          ))}
      </div>

      {/* Scrollable content — plain div avoids Radix ScrollArea's display:table
          inner wrapper which breaks text truncation */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-6 p-4">
          {isLoading && (
            <div className="text-muted-foreground py-8 text-center text-xs">Loading...</div>
          )}

          {!isLoading && !hasAnyContent && <EmptyState category={categoryLabel.toLowerCase()} />}

          {/* Project scope section — always visible when workspace has a repo path */}
          {!isLoading && hasProjectScope && (
            <ScopeSection
              label={repoName ?? "Project"}
              items={visibleProjectItems}
              dimmed={false}
              isEditingItem={isEditingItem}
              addingInScope={addingInScope === "project" ? "project" : null}
              renderEditForm={renderEditForm}
              onEdit={onEdit}
              onDelete={onDelete}
              pendingDeleteItem={pendingDeleteItem?.scope === "project" ? pendingDeleteItem : null}
              onUndoDelete={onUndoDelete}
              onConfirmDelete={onConfirmDelete}
              categoryLabel={categoryLabel}
            />
          )}

          {/* Global scope section */}
          {!isLoading && hasGlobalContent && (
            <div className="space-y-1.5">
              <ScopeSection
                label={hasProjectScope ? "Global" : undefined}
                items={visibleGlobalItems}
                dimmed={dimGlobal && addingInScope !== "global" && editingItem?.scope !== "global"}
                isEditingItem={isEditingItem}
                addingInScope={addingInScope === "global" ? "global" : null}
                renderEditForm={renderEditForm}
                onEdit={onEdit}
                onDelete={dimGlobal ? undefined : onDelete}
                pendingDeleteItem={pendingDeleteItem?.scope === "global" ? pendingDeleteItem : null}
                onUndoDelete={onUndoDelete}
                onConfirmDelete={onConfirmDelete}
                categoryLabel={categoryLabel}
              />
              {/* Global count hint (when dimmed) */}
              {dimGlobal &&
                addingInScope !== "global" &&
                editingItem?.scope !== "global" &&
                visibleGlobalItems.length > 0 && (
                  <p className="text-muted-foreground/60 text-2xs">
                    {visibleGlobalItems.length} global {categoryLabel.toLowerCase()} inherited
                  </p>
                )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  ScopeSection — extracted to reduce duplication between scopes      */
/* ------------------------------------------------------------------ */

interface ScopeSectionProps {
  label?: string;
  items: ConfigDisplayItem[];
  dimmed: boolean;
  isEditingItem: (item: ConfigDisplayItem) => boolean;
  addingInScope: ConfigScope | null;
  renderEditForm?: (item: ConfigDisplayItem | null) => ReactNode;
  onEdit?: (item: ConfigDisplayItem) => void;
  onDelete?: (item: ConfigDisplayItem) => void;
  pendingDeleteItem?: ConfigDisplayItem | null;
  onUndoDelete?: () => void;
  onConfirmDelete?: () => void;
  categoryLabel?: string;
}

function ScopeSection({
  label,
  items,
  dimmed,
  isEditingItem,
  addingInScope,
  renderEditForm,
  onEdit,
  onDelete,
  pendingDeleteItem,
  onUndoDelete,
  onConfirmDelete,
  categoryLabel,
}: ScopeSectionProps) {
  const isEmpty = items.length === 0 && !addingInScope && !pendingDeleteItem;

  return (
    <section>
      {label && (
        <p
          className={cn(
            "mb-2 text-xs font-semibold tracking-wide uppercase",
            dimmed ? "text-muted-foreground/50" : "text-muted-foreground"
          )}
        >
          {label}
        </p>
      )}
      {isEmpty ? (
        <EmptyState category={categoryLabel?.toLowerCase() ?? "items"} />
      ) : (
        <div
          className={cn(
            "border-border/40 overflow-hidden rounded-lg border",
            dimmed && "opacity-50"
          )}
        >
          {/* Single AnimatePresence wraps all conditional animated elements
              so exit animations fire when items switch between edit/row states */}
          <AnimatePresence mode="popLayout">
            {addingInScope && renderEditForm?.(null)}

            {items.map((item) =>
              isEditingItem(item) && renderEditForm ? (
                renderEditForm(item)
              ) : (
                <ConfigItemRow
                  key={`row-${item.scope}-${item.id}`}
                  item={item}
                  onEdit={onEdit}
                  onDelete={onDelete}
                />
              )
            )}

            {pendingDeleteItem && onUndoDelete && onConfirmDelete && (
              <UndoStrip
                key={`undo-${pendingDeleteItem.id}`}
                itemName={pendingDeleteItem.name}
                onUndo={onUndoDelete}
                onExpire={onConfirmDelete}
              />
            )}
          </AnimatePresence>
        </div>
      )}
    </section>
  );
}
