/**
 * MCP Servers category view — fetches, displays, and manages CRUD for MCP server configs.
 *
 * MCP servers have: name (identity), command, args (array), env (key-value map).
 * The API endpoint is /agent-config/mcp-servers (hyphenated).
 *
 * NOTE: MCP servers are saved as a full array via POST /config/mcp-servers,
 * not individually. The save mutation replaces the entire servers list via POST /agent-config/mcp-servers.
 * For add/edit, we rebuild the full list and POST it.
 */

import { useState, useMemo, useCallback } from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useAgentConfigList, useSaveConfigItem } from "../../api/agent-config.queries";
import { CategoryContentArea } from "../CategoryContentArea";
import { ConfigItemExpanded } from "../shared/ConfigItemExpanded";
import { useCategoryCrud } from "../hooks/useCategoryCrud";
import type { ConfigDisplayItem, ConfigScope, McpServerItem } from "../../types";

interface McpViewProps {
  repoPath?: string;
  repoName?: string;
}

function toDisplayItems(items: McpServerItem[], scope: ConfigScope): ConfigDisplayItem[] {
  return items.map((item) => ({
    id: item.name,
    name: item.name,
    description: `${item.command}${item.args.length ? " " + item.args.join(" ") : ""}`,
    scope,
    category: "mcp" as const,
    raw: item,
  }));
}

export function McpView({ repoPath, repoName }: McpViewProps) {
  const globalQuery = useAgentConfigList<McpServerItem[]>("mcp-servers", "global");
  const projectQuery = useAgentConfigList<McpServerItem[]>("mcp-servers", "project", repoPath, {
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

  const saveMutation = useSaveConfigItem("mcp-servers");

  const [formName, setFormName] = useState("");
  const [formCommand, setFormCommand] = useState("");
  const [formArgs, setFormArgs] = useState("");
  const [formEnv, setFormEnv] = useState("");

  const resetForm = useCallback(() => {
    setFormName("");
    setFormCommand("");
    setFormArgs("");
    setFormEnv("");
  }, []);

  const populateForm = useCallback((raw: unknown) => {
    const item = raw as McpServerItem;
    setFormName(item.name);
    setFormCommand(item.command);
    setFormArgs(item.args.join("\n"));
    setFormEnv(
      Object.entries(item.env)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n")
    );
  }, []);

  const crud = useCategoryCrud({ resetForm, populateForm });

  const handleSave = useCallback(
    (originalItem: ConfigDisplayItem | null) => {
      if (!formName.trim() || !formCommand.trim()) return;
      const scope = originalItem?.scope ?? crud.addingInScope ?? "global";
      const args = formArgs
        .split("\n")
        .map((a) => a.trim())
        .filter(Boolean);
      const env: Record<string, string> = {};
      for (const line of formEnv.split("\n")) {
        const eq = line.indexOf("=");
        if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      }

      // MCP servers endpoint expects { servers: [...] } for a full replace.
      // Rebuild the list from query data, replacing or appending the edited server.
      const currentList = (scope === "project" ? projectQuery.data : globalQuery.data) ?? [];
      const newServer: McpServerItem = {
        name: formName.trim(),
        command: formCommand.trim(),
        args,
        env,
      };

      let updatedList: McpServerItem[];
      if (originalItem) {
        updatedList = currentList.map((s) => (s.name === originalItem.id ? newServer : s));
      } else {
        if (currentList.some((s) => s.name === newServer.name)) {
          toast.error(`MCP server "${newServer.name}" already exists`);
          return;
        }
        updatedList = [...currentList, newServer];
      }

      saveMutation.mutate(
        {
          data: { servers: updatedList },
          scope,
          repoPath: scope === "project" ? repoPath : undefined,
        },
        { onSuccess: crud.clearEditing }
      );
    },
    [
      formName,
      formCommand,
      formArgs,
      formEnv,
      crud,
      repoPath,
      saveMutation,
      globalQuery.data,
      projectQuery.data,
    ]
  );

  const handleConfirmDelete = useCallback(() => {
    if (!crud.pendingDelete) return;
    const scope = crud.pendingDelete.scope;
    const currentList = (scope === "project" ? projectQuery.data : globalQuery.data) ?? [];
    const updatedList = currentList.filter((s) => s.name !== crud.pendingDelete!.id);
    saveMutation.mutate(
      {
        data: { servers: updatedList },
        scope,
        repoPath: scope === "project" ? repoPath : undefined,
      },
      { onSettled: () => crud.setPendingDelete(null) }
    );
  }, [crud, repoPath, saveMutation, globalQuery.data, projectQuery.data]);

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
            <Label className="text-xs">Name</Label>
            <Input
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="server-name"
              disabled={!isNew}
              autoFocus={isNew}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Command</Label>
            <Input
              value={formCommand}
              onChange={(e) => setFormCommand(e.target.value)}
              placeholder="npx, node, python..."
              autoFocus={!isNew}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Arguments (one per line)</Label>
            <Textarea
              value={formArgs}
              onChange={(e) => setFormArgs(e.target.value)}
              placeholder={"-y\n@modelcontextprotocol/server-name"}
              rows={2}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Environment variables (KEY=value, one per line)</Label>
            <Textarea
              value={formEnv}
              onChange={(e) => setFormEnv(e.target.value)}
              placeholder={"API_KEY=sk-...\nDEBUG=true"}
              rows={3}
            />
          </div>
        </ConfigItemExpanded>
      );
    },
    [formName, formCommand, formArgs, formEnv, handleSave, crud, saveMutation.isPending]
  );

  return (
    <CategoryContentArea
      categoryLabel="MCP Servers"
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
