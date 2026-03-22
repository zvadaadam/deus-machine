import { useState, useMemo, useCallback, useEffect, useRef, type KeyboardEvent } from "react";
import { useWorkspacesByRepo } from "@/features/workspace/api";
import { useWorkspaceStore } from "@/features/workspace/store";
import { useUIStore } from "@/shared/stores/uiStore";
import { track } from "@/platform/analytics";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
} from "@/components/ui/command";
import { staticCommands, GROUP_LABELS, type CommandGroup as CmdGroup } from "../commands";
import type { Workspace, RepoGroup } from "@/shared/types";

interface CommandPaletteProps {
  /** Runtime action overrides for commands that need native/mutation context */
  actionOverrides?: Record<string, () => void>;
}

export function CommandPalette({ actionOverrides = {} }: CommandPaletteProps) {
  const open = useUIStore((s) => s.commandPaletteOpen);
  const closeCommandPalette = useUIStore((s) => s.closeCommandPalette);

  const [search, setSearch] = useState("");
  const [page, setPage] = useState<"home" | "workspace">("home");
  const prevOpen = useRef(false);

  // Track command palette open (not close)
  useEffect(() => {
    if (open && !prevOpen.current) {
      track("command_palette_opened");
    }
    prevOpen.current = open;
  }, [open]);

  // Workspace data for the "Go to Workspace" search page
  const workspacesQuery = useWorkspacesByRepo();
  const selectWorkspace = useWorkspaceStore((s) => s.selectWorkspace);

  const allWorkspaces = useMemo(() => {
    if (!workspacesQuery.data) return [];
    return workspacesQuery.data.flatMap((group: RepoGroup) =>
      group.workspaces.map((w) => ({
        ...w,
        repoName: group.repo_name,
      }))
    );
  }, [workspacesQuery.data]);

  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      if (!isOpen) {
        closeCommandPalette();
        setSearch("");
        setPage("home");
      }
    },
    [closeCommandPalette]
  );

  const runCommand = useCallback(
    (commandId: string, defaultAction: () => void) => {
      closeCommandPalette();
      setSearch("");
      setPage("home");
      const action = actionOverrides[commandId] ?? defaultAction;
      action();
    },
    [closeCommandPalette, actionOverrides]
  );

  const handleWorkspaceSelect = useCallback(
    (workspace: Workspace) => {
      closeCommandPalette();
      setSearch("");
      setPage("home");
      selectWorkspace(workspace.id);
    },
    [closeCommandPalette, selectWorkspace]
  );

  // Backspace on empty input navigates back from workspace page to home
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (page !== "home" && e.key === "Backspace" && !search) {
        e.preventDefault();
        setPage("home");
      }
    },
    [page, search]
  );

  // Group commands for rendering
  const grouped = useMemo(() => {
    const groups: Record<CmdGroup, typeof staticCommands> = {
      workspace: [],
      project: [],
      navigation: [],
      settings: [],
    };
    for (const cmd of staticCommands) {
      if (cmd.when && !cmd.when()) continue;
      groups[cmd.group].push(cmd);
    }
    return groups;
  }, []);

  return (
    <CommandDialog open={open} onOpenChange={handleOpenChange}>
      <CommandInput
        placeholder={page === "workspace" ? "Search workspaces..." : "Type a command or search..."}
        value={search}
        onValueChange={setSearch}
        onKeyDown={handleKeyDown}
      />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        {page === "home" && (
          <>
            {/* Go to workspace (shows when workspaces exist) */}
            {allWorkspaces.length > 0 && (
              <CommandGroup heading="Go to">
                <CommandItem
                  value="go-to-workspace"
                  keywords={["switch", "workspace", "jump", "select"]}
                  onSelect={() => {
                    setPage("workspace");
                    setSearch("");
                  }}
                >
                  <span className="text-sm">Go to Workspace...</span>
                  <CommandShortcut>{allWorkspaces.length}</CommandShortcut>
                </CommandItem>
              </CommandGroup>
            )}

            {/* Static command groups */}
            {(Object.keys(grouped) as CmdGroup[]).map((groupKey) => {
              const commands = grouped[groupKey];
              if (commands.length === 0) return null;
              return (
                <CommandGroup key={groupKey} heading={GROUP_LABELS[groupKey]}>
                  {commands.map((cmd) => (
                    <CommandItem
                      key={cmd.id}
                      value={cmd.id}
                      keywords={cmd.keywords}
                      onSelect={() => runCommand(cmd.id, cmd.action)}
                    >
                      <cmd.icon className="mr-2 h-4 w-4 opacity-60" />
                      <span>{cmd.label}</span>
                      {cmd.shortcut && <CommandShortcut>{cmd.shortcut}</CommandShortcut>}
                    </CommandItem>
                  ))}
                </CommandGroup>
              );
            })}
          </>
        )}

        {/* Workspace search page */}
        {page === "workspace" && (
          <CommandGroup heading="Workspaces">
            {allWorkspaces.map((ws) => (
              <CommandItem
                key={ws.id}
                value={`${ws.title || ws.slug} ${ws.repoName}`}
                onSelect={() => handleWorkspaceSelect(ws)}
              >
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm">{ws.title || ws.slug}</span>
                  <span className="text-muted-foreground text-xs">
                    {ws.repoName}
                    {ws.git_branch ? ` \u00b7 ${ws.git_branch}` : ""}
                  </span>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
