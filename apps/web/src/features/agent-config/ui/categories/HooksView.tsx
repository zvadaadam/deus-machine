/**
 * Hooks category view — fetches, displays, and manages CRUD for hook configurations.
 *
 * Hooks are stored as { [eventName]: matcherGroup[] } in settings.json.
 * Each matcher group: { matcher: string, hooks: Array<{ type, command, timeout? }> }
 * The save endpoint expects the full hooks object — add/edit/delete rebuild
 * the complete map and POST it.
 *
 * Display: summarizes commands inline (e.g. "→ setup.sh (10s)" instead of "1 handler").
 * Editor: structured form with matcher pattern, command rows, and timeout fields.
 */

import { useState, useMemo, useCallback } from "react";
import { Plus, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAgentConfigList, useSaveConfigItem } from "../../api/agent-config.queries";
import { CategoryContentArea } from "../CategoryContentArea";
import { ConfigItemExpanded } from "../shared/ConfigItemExpanded";
import { useCategoryCrud } from "../hooks/useCategoryCrud";
import type { ConfigDisplayItem, ConfigScope, HookMatcherGroup, HooksMap } from "../../types";

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

interface FormCommand {
  command: string;
  timeout: string;
}

interface FormMatcherGroup {
  matcher: string;
  commands: FormCommand[];
}

interface HooksViewProps {
  repoPath?: string;
  repoName?: string;
}

const EMPTY_FORM_GROUP: FormMatcherGroup = {
  matcher: "",
  commands: [{ command: "", timeout: "" }],
};

function createEmptyGroups(): FormMatcherGroup[] {
  return [{ ...EMPTY_FORM_GROUP, commands: [{ ...EMPTY_FORM_GROUP.commands[0] }] }];
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Summarize hook handlers into a human-readable description line */
function summarizeHandlers(handlers: HookMatcherGroup[]): string {
  if (!Array.isArray(handlers) || handlers.length === 0) return "No handlers";

  const groups = handlers;
  const totalCommands = groups.reduce((n, g) => n + (g.hooks?.length ?? 0), 0);

  if (totalCommands === 0) return "No commands";

  // Multiple matcher groups — show aggregate
  if (groups.length > 1) {
    return `${groups.length} groups, ${totalCommands} command${totalCommands !== 1 ? "s" : ""}`;
  }

  // Single group — show first command details
  const group = groups[0];
  const first = group.hooks?.[0];
  if (!first?.command) return `${totalCommands} command${totalCommands !== 1 ? "s" : ""}`;

  const basename = first.command.split("/").pop() ?? first.command;
  const matcher = group.matcher ? `${group.matcher} → ` : "→ ";
  const timeout = first.timeout ? ` (${first.timeout}s)` : "";
  const suffix = totalCommands > 1 ? ` +${totalCommands - 1} more` : "";

  return `${matcher}${basename}${timeout}${suffix}`;
}

function hooksToDisplayItems(hooks: HooksMap | undefined, scope: ConfigScope): ConfigDisplayItem[] {
  if (!hooks || typeof hooks !== "object") return [];
  return Object.entries(hooks).map(([event, handlers]) => ({
    id: event,
    name: event,
    description: summarizeHandlers(handlers),
    scope,
    category: "hooks" as const,
    raw: { event, handlers },
  }));
}

/** Convert raw handlers to structured form state */
function handlersToFormGroups(handlers: HookMatcherGroup[] | undefined): FormMatcherGroup[] {
  if (!Array.isArray(handlers) || handlers.length === 0) {
    return createEmptyGroups();
  }

  return handlers.map((h) => ({
    matcher: h.matcher ?? "",
    commands:
      Array.isArray(h.hooks) && h.hooks.length > 0
        ? h.hooks.map((cmd) => ({
            command: cmd.command ?? "",
            timeout: cmd.timeout != null ? String(cmd.timeout) : "",
          }))
        : [{ command: "", timeout: "" }],
  }));
}

/** Convert form state back to API format */
function formGroupsToHandlers(groups: FormMatcherGroup[]) {
  return groups
    .map((g) => ({
      matcher: g.matcher,
      hooks: g.commands
        .filter((c) => c.command.trim())
        .map((c) => ({
          type: "command" as const,
          command: c.command.trim(),
          ...(c.timeout.trim() && !isNaN(Number(c.timeout)) ? { timeout: Number(c.timeout) } : {}),
        })),
    }))
    .filter((g) => g.hooks.length > 0);
}

/** Known Claude Code hook events with descriptions and matcher hints */
interface HookEventDef {
  value: string;
  desc: string;
  matcher?: string;
}

const HOOK_EVENTS: { group: string; items: HookEventDef[] }[] = [
  {
    group: "Session",
    items: [
      { value: "SessionStart", desc: "Fires when a session begins" },
      { value: "SessionEnd", desc: "Fires when a session ends" },
      { value: "Stop", desc: "Fires when the agent stops" },
    ],
  },
  {
    group: "User",
    items: [
      { value: "UserPromptSubmit", desc: "Fires when user sends a message" },
      { value: "Notification", desc: "Fires on desktop notifications" },
    ],
  },
  {
    group: "Tools",
    items: [
      { value: "PreToolUse", desc: "Before a tool executes", matcher: "tool name" },
      { value: "PostToolUse", desc: "After a tool executes", matcher: "tool name" },
      { value: "PostToolUseFailure", desc: "After a tool fails", matcher: "tool name" },
      { value: "PermissionRequest", desc: "When a tool requests permission", matcher: "tool name" },
    ],
  },
  {
    group: "Agents",
    items: [
      { value: "SubagentStart", desc: "When a sub-agent spawns", matcher: "agent type" },
      { value: "SubagentStop", desc: "When a sub-agent finishes", matcher: "agent type" },
      { value: "TeammateIdle", desc: "When a teammate goes idle" },
      { value: "TaskCompleted", desc: "When a task completes" },
    ],
  },
  {
    group: "System",
    items: [
      { value: "ConfigChange", desc: "When config files change", matcher: "config source" },
      { value: "PreCompact", desc: "Before context compaction" },
      { value: "WorktreeCreate", desc: "When a git worktree is created" },
      { value: "WorktreeRemove", desc: "When a git worktree is removed" },
    ],
  },
];

/** Return a contextual placeholder for the matcher input based on event type */
function getMatcherHint(event: string): string {
  const all = HOOK_EVENTS.flatMap((g) => g.items);
  const found = all.find((e) => e.value === event);
  if (found && "matcher" in found) return `Match by ${found.matcher} (empty = always)`;
  return "Pattern (empty = always match)";
}

/* ------------------------------------------------------------------ */
/*  Component                                                           */
/* ------------------------------------------------------------------ */

export function HooksView({ repoPath, repoName }: HooksViewProps) {
  const globalQuery = useAgentConfigList<HooksMap>("hooks", "global");
  const projectQuery = useAgentConfigList<HooksMap>("hooks", "project", repoPath, {
    enabled: !!repoPath,
  });

  const globalItems = useMemo(
    () => hooksToDisplayItems(globalQuery.data, "global"),
    [globalQuery.data]
  );
  const projectItems = useMemo(
    () => hooksToDisplayItems(projectQuery.data, "project"),
    [projectQuery.data]
  );
  const isLoading = globalQuery.isLoading || (!!repoPath && projectQuery.isLoading);

  const saveMutation = useSaveConfigItem("hooks");

  const [formEvent, setFormEvent] = useState("");
  const [formGroups, setFormGroups] = useState<FormMatcherGroup[]>(createEmptyGroups);

  const resetForm = useCallback(() => {
    setFormEvent("");
    setFormGroups(createEmptyGroups());
  }, []);

  const populateForm = useCallback((raw: unknown) => {
    const item = raw as { event: string; handlers: HookMatcherGroup[] };
    setFormEvent(item.event);
    setFormGroups(handlersToFormGroups(item.handlers));
  }, []);

  const crud = useCategoryCrud({ resetForm, populateForm });

  /* -- Group/command updaters (stable via functional setState) -- */

  const updateGroupMatcher = useCallback((gi: number, value: string) => {
    setFormGroups((prev) => prev.map((g, i) => (i === gi ? { ...g, matcher: value } : g)));
  }, []);

  const updateCommand = useCallback(
    (gi: number, ci: number, field: keyof FormCommand, value: string) => {
      setFormGroups((prev) =>
        prev.map((g, i) =>
          i === gi
            ? {
                ...g,
                commands: g.commands.map((c, j) => (j === ci ? { ...c, [field]: value } : c)),
              }
            : g
        )
      );
    },
    []
  );

  const addCommand = useCallback((gi: number) => {
    setFormGroups((prev) =>
      prev.map((g, i) =>
        i === gi ? { ...g, commands: [...g.commands, { command: "", timeout: "" }] } : g
      )
    );
  }, []);

  const removeCommand = useCallback((gi: number, ci: number) => {
    setFormGroups((prev) =>
      prev.map((g, i) => (i === gi ? { ...g, commands: g.commands.filter((_, j) => j !== ci) } : g))
    );
  }, []);

  const addGroup = useCallback(() => {
    setFormGroups((prev) => [...prev, { matcher: "", commands: [{ command: "", timeout: "" }] }]);
  }, []);

  const removeGroup = useCallback((gi: number) => {
    setFormGroups((prev) => prev.filter((_, i) => i !== gi));
  }, []);

  /* -- CRUD handlers -- */

  const handleSave = useCallback(
    (originalItem: ConfigDisplayItem | null) => {
      if (!formEvent.trim()) return;
      const scope = originalItem?.scope ?? crud.addingInScope ?? "global";
      const relevantQuery = scope === "project" ? projectQuery : globalQuery;
      if (relevantQuery.status !== "success") return;
      const currentHooks = relevantQuery.data ?? {};

      const parsedHandlers = formGroupsToHandlers(formGroups);
      const updatedHooks = { ...currentHooks, [formEvent.trim()]: parsedHandlers };

      saveMutation.mutate(
        {
          data: { hooks: updatedHooks },
          scope,
          repoPath: scope === "project" ? repoPath : undefined,
        },
        { onSuccess: crud.clearEditing }
      );
    },
    [formEvent, formGroups, crud, repoPath, saveMutation, globalQuery.data, projectQuery.data]
  );

  // Hooks don't have a separate delete endpoint — deletion is done by
  // removing the event key from the hooks object and saving the full map.
  const handleConfirmDelete = useCallback(() => {
    if (!crud.pendingDelete) return;
    const scope = crud.pendingDelete.scope;
    const currentHooks = (scope === "project" ? projectQuery.data : globalQuery.data) ?? {};
    const { [crud.pendingDelete.id]: _, ...remaining } = currentHooks;
    saveMutation.mutate(
      { data: { hooks: remaining }, scope, repoPath: scope === "project" ? repoPath : undefined },
      { onSettled: () => crud.setPendingDelete(null) }
    );
  }, [crud, repoPath, saveMutation, globalQuery.data, projectQuery.data]);

  /* -- Render edit form -- */

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
              <Label className="text-xs">Event</Label>
              <Select value={formEvent} onValueChange={setFormEvent}>
                <SelectTrigger className="w-full text-xs">
                  <SelectValue placeholder="Select a hook event..." />
                </SelectTrigger>
                <SelectContent>
                  {HOOK_EVENTS.map((group) => (
                    <SelectGroup key={group.group}>
                      <SelectLabel>{group.group}</SelectLabel>
                      {group.items.map((evt) => (
                        <SelectItem key={evt.value} value={evt.value} className="text-xs">
                          <span className="font-medium">{evt.value}</span>
                          <span className="text-muted-foreground ml-2">{evt.desc}</span>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <p className="text-muted-foreground text-xs font-medium">{formEvent}</p>
          )}

          {formGroups.map((group, gi) => (
            <div
              key={gi}
              className="border-border/30 bg-background/50 space-y-2 rounded-md border p-3"
            >
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground text-2xs font-medium tracking-wide uppercase">
                  {formGroups.length > 1 ? `Matcher group ${gi + 1}` : "Matcher"}
                </span>
                {formGroups.length > 1 && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground h-5 w-5"
                    onClick={() => removeGroup(gi)}
                    aria-label="Remove matcher group"
                  >
                    <X className="h-3 w-3" />
                  </Button>
                )}
              </div>

              <Input
                value={group.matcher}
                onChange={(e) => updateGroupMatcher(gi, e.target.value)}
                placeholder={getMatcherHint(formEvent)}
                className="text-xs"
                autoFocus={!isNew && gi === 0}
              />

              <div className="space-y-1.5">
                <Label className="text-2xs text-muted-foreground">Commands</Label>
                {group.commands.map((cmd, ci) => (
                  <div key={ci} className="flex items-center gap-2">
                    <Input
                      value={cmd.command}
                      onChange={(e) => updateCommand(gi, ci, "command", e.target.value)}
                      placeholder="/path/to/script.sh"
                      className="flex-1 font-mono text-xs"
                    />
                    <div className="flex shrink-0 items-center gap-1">
                      <Input
                        type="number"
                        min={0}
                        value={cmd.timeout}
                        onChange={(e) => updateCommand(gi, ci, "timeout", e.target.value)}
                        placeholder="10"
                        className="w-14 text-center text-xs"
                      />
                      <span className="text-muted-foreground text-2xs">s</span>
                    </div>
                    {group.commands.length > 1 && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-muted-foreground h-6 w-6 shrink-0"
                        onClick={() => removeCommand(gi, ci)}
                        aria-label="Remove command"
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                ))}
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground h-6 gap-1 px-2 text-xs"
                  onClick={() => addCommand(gi)}
                >
                  <Plus className="h-3 w-3" />
                  Add command
                </Button>
              </div>
            </div>
          ))}

          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground h-6 gap-1 px-2 text-xs"
            onClick={addGroup}
          >
            <Plus className="h-3 w-3" />
            Add matcher group
          </Button>
        </ConfigItemExpanded>
      );
    },
    [
      formEvent,
      formGroups,
      handleSave,
      crud,
      saveMutation.isPending,
      updateGroupMatcher,
      updateCommand,
      addCommand,
      removeCommand,
      addGroup,
      removeGroup,
    ]
  );

  return (
    <CategoryContentArea
      categoryLabel="Hooks"
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
