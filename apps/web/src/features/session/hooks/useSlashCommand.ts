import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { readAgentConfig } from "@/features/agent-config/api/agent-config.service";
import type { SkillItem, CommandItem } from "@shared/types/agent-config";
import type { AgentConfigReach } from "@/features/workspace/lib/reach";

interface SlashItem {
  name: string;
  description: string;
}

type AgentSlashItem = SlashItem & { kind: "skill" | "command" };
type SlashAction = SlashItem & { kind: "action"; run: () => void };
export type SlashCommandItem = AgentSlashItem | SlashAction;

interface UseSlashCommandOptions {
  /** Current textarea value */
  value: string;
  /**
   * Whose configuration the agent has (`agentConfigOf`): on this computer, its
   * own and the workspace folder's; in the cloud, none of this computer's.
   */
  config: AgentConfigReach;
  /** In the cloud: what reaches the agent from here (the skills a cloud turn carries). */
  cloudItems?: AgentSlashItem[];
  /** Callback to update the textarea value after inserting a command */
  onChange: (newValue: string) => void;
  includeAgentCommands: boolean;
  actions: SlashAction[];
  /**
   * When provided, selecting a skill adds a structured mention via this callback
   * instead of inserting `/name ` text inline. The `/query` the user typed is
   * removed. Commands still use the legacy text-insertion path since they're
   * typically one-off actions (e.g. /clear).
   */
  onAddSkill?: (skill: AgentSlashItem) => void;
}

interface UseSlashCommandReturn {
  /** Whether the slash command popover should be open */
  isOpen: boolean;
  /** The search query extracted from text after / */
  query: string;
  /** Filtered items matching the query */
  results: SlashCommandItem[];
  /** Whether items are still loading from backend */
  loading: boolean;
  /** Call when user selects an item from the popover */
  selectItem: (name: string) => void;
  /** Call to dismiss the popover */
  dismiss: () => void;
  /** Attach to textarea's onKeyDown for arrow/enter/escape handling */
  handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** Index of currently highlighted result (for keyboard navigation) */
  selectedIndex: number;
}

/** Skills first, then commands, then alphabetically within each group. */
function sortItems(items: AgentSlashItem[]): AgentSlashItem[] {
  return [...items].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "skill" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * What the `/` menu lists for an agent on this computer: this computer's own
 * skills and commands (`~/.claude`) and the workspace folder's, the folder's
 * first (they override this computer's with the same name). `read` is
 * injectable for tests.
 */
export async function readLocalSlashItems(
  folder: string | null,
  read: typeof readAgentConfig = readAgentConfig
): Promise<AgentSlashItem[]> {
  const [globalSkills, globalCommands, projectSkills, projectCommands] = await Promise.allSettled([
    read("skills", "global"),
    read("commands", "global"),
    folder ? read("skills", "project", folder) : [],
    folder ? read("commands", "project", folder) : [],
  ]);

  const items: AgentSlashItem[] = [];
  const seen = new Set<string>();
  const addItems = (
    result: PromiseSettledResult<SkillItem[] | CommandItem[]>,
    kind: "skill" | "command"
  ) => {
    if (result.status !== "fulfilled" || !Array.isArray(result.value)) return;
    for (const item of result.value) {
      if (!seen.has(item.name)) {
        seen.add(item.name);
        items.push({ name: item.name, description: item.description, kind });
      }
    }
  };
  addItems(projectSkills, "skill");
  addItems(projectCommands, "command");
  addItems(globalSkills, "skill");
  addItems(globalCommands, "command");
  return sortItems(items);
}

/** The `/` menu's items for a cloud agent: only what reaches it from here, never this computer's folders. */
export function cloudSlashItems(cloudItems: AgentSlashItem[] | undefined): AgentSlashItem[] {
  return sortItems(cloudItems ?? []);
}

export function withSlashActions(
  actions: SlashAction[],
  items: AgentSlashItem[]
): SlashCommandItem[] {
  return [
    ...actions,
    ...items.filter((item) => !actions.some((action) => action.name === item.name)),
  ];
}

export function useSlashCommand({
  value,
  config,
  cloudItems,
  onChange,
  includeAgentCommands,
  actions,
  onAddSkill,
}: UseSlashCommandOptions): UseSlashCommandReturn {
  const triggerActive = (includeAgentCommands || actions.length > 0) && /^\/\S*$/.test(value);
  const [open, setIsOpen] = useState(triggerActive);
  const isOpen = triggerActive && open;
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Cached items from backend (fetched per workspace, filtered client-side)
  const [localItems, setLocalItems] = useState<AgentSlashItem[]>([]);
  const cloud = config.where === "cloud";
  const workspacePath = config.where === "local" ? config.folder : null;
  const [loading, setLoading] = useState(false);
  const fetchedWorkspaceRef = useRef<string | null>(null);

  const query = triggerActive ? value.slice(1) : "";

  // Open/close based on trigger — query in deps so Escape → continued typing reopens
  useEffect(() => {
    if (triggerActive) {
      setIsOpen(true);
      setSelectedIndex(0);
    } else {
      setIsOpen(false);
    }
  }, [triggerActive, query]);

  // Fetch skills + commands when popover first opens (re-fetches on workspace change)
  useEffect(() => {
    // A cloud agent does not run here: nothing on this computer's disk applies.
    if (!isOpen || !includeAgentCommands || cloud) return;
    const cacheKey = workspacePath ?? "__global__";
    if (fetchedWorkspaceRef.current === cacheKey) return;
    fetchedWorkspaceRef.current = cacheKey;

    const fetchItems = async () => {
      setLoading(true);
      try {
        setLocalItems(await readLocalSlashItems(workspacePath));
      } catch (err) {
        console.error("[useSlashCommand] Failed to fetch items:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchItems();
  }, [isOpen, includeAgentCommands, cloud, workspacePath]);

  // Filter items by query (client-side fuzzy match)
  const results = useMemo(() => {
    if (!isOpen) return [];
    const items = includeAgentCommands
      ? withSlashActions(actions, cloud ? cloudSlashItems(cloudItems) : localItems)
      : actions;
    if (!query) return items;

    const lowerQuery = query.toLowerCase();
    return items.filter(
      (item) =>
        item.name.toLowerCase().includes(lowerQuery) ||
        item.description.toLowerCase().includes(lowerQuery)
    );
  }, [isOpen, query, actions, includeAgentCommands, cloud, cloudItems, localItems]);

  // Reset selected index when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [results.length]);

  const selectItem = useCallback(
    (name: string) => {
      const item = results.find((i) => i.name === name);
      if (item?.kind === "action") {
        onChange("");
        item.run();
      } else if (onAddSkill && item?.kind === "skill") {
        onAddSkill(item);
        // Remove the typed `/query` — the whole textarea starts with `/` and
        // contains no spaces when the trigger is active, so clearing is safe.
        onChange("");
      } else {
        onChange(`/${name} `);
      }
      setIsOpen(false);
    },
    [onChange, onAddSkill, results]
  );

  // Dismiss the popover
  const dismiss = useCallback(() => {
    setIsOpen(false);
  }, []);

  // Keyboard navigation — returns true if the event was consumed
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!isOpen || results.length === 0) return false;

      switch (e.key) {
        case "ArrowDown":
          setSelectedIndex((prev) => Math.min(prev + 1, results.length - 1));
          return true;
        case "ArrowUp":
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          return true;
        case "Tab":
        case "Enter": {
          if (e.metaKey || e.ctrlKey) return false;
          const selected = results[selectedIndex];
          if (selected) {
            selectItem(selected.name);
          }
          return true;
        }
        case "Escape":
          dismiss();
          return true;
        default:
          return false;
      }
    },
    [isOpen, results, selectedIndex, selectItem, dismiss]
  );

  return {
    isOpen: isOpen && (includeAgentCommands || results.length > 0),
    query,
    results,
    loading: includeAgentCommands && loading,
    selectItem,
    dismiss,
    handleKeyDown,
    selectedIndex,
  };
}
