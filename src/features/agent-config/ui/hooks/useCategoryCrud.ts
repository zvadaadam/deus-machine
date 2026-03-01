/**
 * Shared CRUD state machine for category views.
 *
 * Every category view (Skills, Commands, Agents, MCP, Hooks) manages the
 * same add/edit/delete toggling logic. This hook extracts that shared
 * state into one place, leaving view-specific concerns (form fields,
 * save logic, delete logic, render) to the caller.
 */

import { useState, useCallback } from "react";
import type { ConfigDisplayItem, ConfigScope } from "../../types";

interface UseCategoryCrudOptions {
  /** Reset all form fields to empty (view-specific) */
  resetForm: () => void;
  /** Populate form fields from a raw config item (view-specific) */
  populateForm: (raw: unknown) => void;
}

export function useCategoryCrud({ resetForm, populateForm }: UseCategoryCrudOptions) {
  const [addingInScope, setAddingInScope] = useState<ConfigScope | null>(null);
  const [editingItem, setEditingItem] = useState<ConfigDisplayItem | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ConfigDisplayItem | null>(null);

  /** Clear all editing state and reset form — used by cancel buttons */
  const clearEditing = useCallback(() => {
    setAddingInScope(null);
    setEditingItem(null);
    resetForm();
  }, [resetForm]);

  /** Toggle add mode for a scope. Second click on same scope cancels. */
  const handleAdd = useCallback(
    (scope: ConfigScope) => {
      if (addingInScope === scope) {
        clearEditing();
        return;
      }
      resetForm();
      setEditingItem(null);
      setAddingInScope(scope);
    },
    [addingInScope, resetForm, clearEditing]
  );

  /** Toggle edit mode for an item. Second click on same item cancels. */
  const handleEdit = useCallback(
    (item: ConfigDisplayItem) => {
      if (editingItem?.id === item.id && editingItem?.scope === item.scope) {
        clearEditing();
        return;
      }
      populateForm(item.raw);
      setAddingInScope(null);
      setEditingItem(item);
    },
    [editingItem, populateForm, clearEditing]
  );

  /** Mark an item for deletion (shows undo strip) */
  const handleDelete = useCallback((item: ConfigDisplayItem) => setPendingDelete(item), []);

  /** Cancel pending delete (undo) */
  const handleUndoDelete = useCallback(() => setPendingDelete(null), []);

  return {
    addingInScope,
    editingItem,
    pendingDelete,
    setPendingDelete,
    handleAdd,
    handleEdit,
    handleDelete,
    handleUndoDelete,
    clearEditing,
  };
}
