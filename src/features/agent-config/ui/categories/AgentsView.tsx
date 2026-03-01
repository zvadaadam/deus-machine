/**
 * Agents category view — fetches, displays, and manages CRUD for agent configs.
 *
 * Agents have: id (identity/filename), name, description.
 * ID is read-only when editing; all other fields are editable.
 */

import { useState, useMemo, useCallback } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  useAgentConfigList,
  useSaveConfigItem,
  useDeleteConfigItem,
} from "../../api/agent-config.queries";
import { CategoryContentArea } from "../CategoryContentArea";
import { ConfigItemExpanded } from "../shared/ConfigItemExpanded";
import { useCategoryCrud } from "../hooks/useCategoryCrud";
import type { ConfigDisplayItem, ConfigScope, AgentItem } from "../../types";

interface AgentsViewProps {
  repoPath?: string;
  repoName?: string;
}

function toDisplayItems(items: AgentItem[], scope: ConfigScope): ConfigDisplayItem[] {
  return items.map((item) => ({
    id: item.id,
    name: item.name ?? item.id,
    description: item.description ?? "",
    scope,
    category: "agents" as const,
    raw: item,
  }));
}

export function AgentsView({ repoPath, repoName }: AgentsViewProps) {
  const globalQuery = useAgentConfigList<AgentItem[]>("agents", "global");
  const projectQuery = useAgentConfigList<AgentItem[]>("agents", "project", repoPath, {
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

  const saveMutation = useSaveConfigItem("agents");
  const deleteMutation = useDeleteConfigItem("agents");

  const [formId, setFormId] = useState("");
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");

  const resetForm = useCallback(() => {
    setFormId("");
    setFormName("");
    setFormDescription("");
  }, []);

  const populateForm = useCallback((raw: unknown) => {
    const item = raw as AgentItem;
    setFormId(item.id);
    setFormName(item.name ?? "");
    setFormDescription(item.description ?? "");
  }, []);

  const crud = useCategoryCrud({ resetForm, populateForm });

  const handleSave = useCallback(
    (originalItem: ConfigDisplayItem | null) => {
      if (!formId.trim()) return;
      const scope = originalItem?.scope ?? crud.addingInScope ?? "global";
      saveMutation.mutate(
        {
          data: {
            id: formId.trim(),
            name: formName.trim() || undefined,
            description: formDescription.trim() || undefined,
          },
          scope,
          repoPath: scope === "project" ? repoPath : undefined,
        },
        { onSuccess: crud.clearEditing }
      );
    },
    [
      formId,
      formName,
      formDescription,
      crud.addingInScope,
      crud.clearEditing,
      repoPath,
      saveMutation,
    ]
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
          <div className="space-y-1">
            <Label className="text-xs">ID</Label>
            <Input
              value={formId}
              onChange={(e) => setFormId(e.target.value)}
              placeholder="agent-id"
              disabled={!isNew}
              autoFocus={isNew}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Name</Label>
            <Input
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="Agent display name"
              autoFocus={!isNew}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Description</Label>
            <Input
              value={formDescription}
              onChange={(e) => setFormDescription(e.target.value)}
              placeholder="What this agent does..."
            />
          </div>
        </ConfigItemExpanded>
      );
    },
    [formId, formName, formDescription, handleSave, crud.clearEditing, saveMutation.isPending]
  );

  return (
    <CategoryContentArea
      categoryLabel="Agents"
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
