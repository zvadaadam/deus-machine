/**
 * Commands category view — fetches, displays, and manages CRUD for commands.
 *
 * Commands have: name (identity/filename) + content (shell command string).
 * Same shape as Skills — name read-only on edit, editable on add.
 */

import { useState, useMemo, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  useAgentConfigList,
  useSaveConfigItem,
  useDeleteConfigItem,
} from "../../api/agent-config.queries";
import { CategoryContentArea } from "../CategoryContentArea";
import { ConfigItemExpanded } from "../shared/ConfigItemExpanded";
import { useCategoryCrud } from "../hooks/useCategoryCrud";
import type { ConfigDisplayItem, ConfigScope, CommandItem } from "../../types";

interface CommandsViewProps {
  repoPath?: string;
  repoName?: string;
}

function toDisplayItems(items: CommandItem[], scope: ConfigScope): ConfigDisplayItem[] {
  return items.map((item) => ({
    id: item.name,
    name: item.name,
    description: item.description,
    scope,
    category: "commands" as const,
    raw: item,
  }));
}

export function CommandsView({ repoPath, repoName }: CommandsViewProps) {
  const globalQuery = useAgentConfigList<CommandItem[]>("commands", "global");
  const projectQuery = useAgentConfigList<CommandItem[]>("commands", "project", repoPath, {
    enabled: !!repoPath,
  });

  const globalItems = useMemo(
    () => toDisplayItems(globalQuery.data ?? [], "global"),
    [globalQuery.data]
  );
  const projectItems = useMemo(
    () => toDisplayItems(projectQuery.data ?? [], "project"),
    [projectQuery.data]
  );
  const isLoading = globalQuery.isLoading || (!!repoPath && projectQuery.isLoading);

  const saveMutation = useSaveConfigItem("commands");
  const deleteMutation = useDeleteConfigItem("commands");

  const [formName, setFormName] = useState("");
  const [formContent, setFormContent] = useState("");

  const resetForm = useCallback(() => {
    setFormName("");
    setFormContent("");
  }, []);

  const populateForm = useCallback((raw: unknown) => {
    const item = raw as CommandItem;
    setFormName(item.name);
    setFormContent(item.content);
  }, []);

  const crud = useCategoryCrud({ resetForm, populateForm });

  const handleSave = useCallback(
    (originalItem: ConfigDisplayItem | null) => {
      if (!formName.trim() || !formContent.trim()) return;
      const scope = originalItem?.scope ?? crud.addingInScope ?? "global";
      saveMutation.mutate(
        {
          data: { name: formName.trim(), content: formContent },
          scope,
          repoPath: scope === "project" ? repoPath : undefined,
        },
        { onSuccess: crud.clearEditing }
      );
    },
    [formName, formContent, crud, repoPath, saveMutation]
  );

  const handleConfirmDelete = useCallback(() => {
    if (!crud.pendingDelete) return;
    deleteMutation.mutate(
      {
        id: crud.pendingDelete.id,
        scope: crud.pendingDelete.scope,
        repoPath: crud.pendingDelete.scope === "project" ? repoPath : undefined,
      },
      { onSettled: () => crud.setPendingDelete(null) }
    );
  }, [crud, repoPath, deleteMutation]);

  const renderEditForm = useCallback(
    (item: ConfigDisplayItem | null) => {
      const isNew = item === null;
      return (
        <ConfigItemExpanded
          key={isNew ? "add-form" : `edit-${item.scope}-${item.id}`}
          onSave={() => handleSave(item)}
          onCancel={crud.clearEditing}
          isSaving={saveMutation.isPending}
          saveLabel={isNew ? "Create" : "Save"}
        >
          {isNew ? (
            <div className="space-y-1">
              <Label className="text-xs">Name</Label>
              <Input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="command-name"
                autoFocus
              />
            </div>
          ) : (
            <p className="text-muted-foreground text-xs font-medium">{formName}</p>
          )}
          <Textarea
            value={formContent}
            onChange={(e) => setFormContent(e.target.value)}
            placeholder="Command content..."
            rows={8}
            className="max-h-[400px] min-h-[100px] resize-y font-mono text-xs leading-relaxed"
            autoFocus={!isNew}
          />
        </ConfigItemExpanded>
      );
    },
    [formName, formContent, handleSave, crud, saveMutation.isPending]
  );

  return (
    <CategoryContentArea
      categoryLabel="Commands"
      globalItems={globalItems}
      projectItems={projectItems}
      repoName={repoName}
      repoPath={repoPath}
      isLoading={isLoading}
      onAdd={crud.handleAdd}
      onEdit={crud.handleEdit}
      onDelete={crud.handleDelete}
      editingItem={crud.editingItem}
      addingInScope={crud.addingInScope}
      renderEditForm={renderEditForm}
      pendingDeleteItem={crud.pendingDelete}
      onUndoDelete={crud.handleUndoDelete}
      onConfirmDelete={handleConfirmDelete}
    />
  );
}
