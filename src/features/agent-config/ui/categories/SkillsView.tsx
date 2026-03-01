/**
 * Skills category view — fetches, displays, and manages CRUD for skills.
 *
 * Skills have: name (identity/filename) + content (markdown body).
 * Name is read-only when editing (identity can't change); editable when adding.
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
import type { ConfigDisplayItem, ConfigScope, SkillItem } from "../../types";

interface SkillsViewProps {
  repoPath?: string;
  repoName?: string;
}

function toDisplayItems(items: SkillItem[], scope: ConfigScope): ConfigDisplayItem[] {
  return items.map((item) => ({
    id: item.name,
    name: item.name,
    description: item.description,
    scope,
    category: "skills" as const,
    raw: item,
  }));
}

export function SkillsView({ repoPath, repoName }: SkillsViewProps) {
  const globalQuery = useAgentConfigList<SkillItem[]>("skills", "global");
  const projectQuery = useAgentConfigList<SkillItem[]>("skills", "project", repoPath, {
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

  const saveMutation = useSaveConfigItem("skills");
  const deleteMutation = useDeleteConfigItem("skills");

  const [formName, setFormName] = useState("");
  const [formContent, setFormContent] = useState("");

  const resetForm = useCallback(() => {
    setFormName("");
    setFormContent("");
  }, []);

  const populateForm = useCallback((raw: unknown) => {
    const item = raw as SkillItem;
    setFormName(item.name);
    setFormContent(item.content);
  }, []);

  const crud = useCategoryCrud({ resetForm, populateForm });

  const handleSave = useCallback(
    (originalItem: ConfigDisplayItem | null) => {
      if (!formName.trim()) return;
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
                placeholder="skill-name"
                autoFocus
              />
            </div>
          ) : (
            <p className="text-muted-foreground text-xs font-medium">{formName}</p>
          )}
          <Textarea
            value={formContent}
            onChange={(e) => setFormContent(e.target.value)}
            placeholder="Skill content (markdown)..."
            rows={14}
            className="max-h-[480px] min-h-[140px] resize-y font-mono text-xs leading-relaxed"
            autoFocus={!isNew}
          />
        </ConfigItemExpanded>
      );
    },
    [formName, formContent, handleSave, crud, saveMutation.isPending]
  );

  return (
    <CategoryContentArea
      categoryLabel="Skills"
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
