/**
 * useSlashCommand — Detects `/` trigger in textarea and shows available skills & commands
 *
 * When the user types `/` at position 0 (start of message), opens a popover
 * listing available skills and commands. Items are fetched once via TanStack Query
 * and filtered client-side as the user types.
 */

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { sendRequest } from "@/platform/ws";
import type { SkillItem, CommandItem } from "@shared/types/agent-config";

export interface SlashCommandItem {
  name: string;
  description: string;
  /** "skill" or "command" — used for visual distinction */
  kind: "skill" | "command";
}

interface UseSlashCommandOptions {
  /** Current textarea value */
  value: string;
  /** Workspace repo path for project-scoped items */
  workspacePath?: string | null;
  /** Callback to update the textarea value after inserting a command */
  onChange: (newValue: string) => void;
  /** Disable the hook entirely (e.g. for Codex which doesn't support skills) */
  enabled?: boolean;
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

/**
 * Detect `/` trigger at position 0 of the input.
 * Returns true when the input starts with `/` and contains no spaces
 * (the user is typing a single-token command name).
 */
function isSlashTriggerActive(value: string): boolean {
  if (!value.startsWith("/")) return false;
  // Only the first "word" — if there's a space, the command is already complete
  return !value.slice(1).includes(" ");
}

export function useSlashCommand({
  value,
  workspacePath,
  onChange,
  enabled = true,
}: UseSlashCommandOptions): UseSlashCommandReturn {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Cached items from backend (fetched per workspace, filtered client-side)
  const [allItems, setAllItems] = useState<SlashCommandItem[]>([]);
  const [loading, setLoading] = useState(false);
  const fetchedWorkspaceRef = useRef<string | null>(null);

  // Detect trigger (disabled entirely for agents that don't support skills)
  const triggerActive = enabled && isSlashTriggerActive(value);
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
    if (!isOpen) return;
    const cacheKey = workspacePath ?? "__global__";
    if (fetchedWorkspaceRef.current === cacheKey) return;
    fetchedWorkspaceRef.current = cacheKey;

    const fetchItems = async () => {
      setLoading(true);
      try {
        const [globalSkills, globalCommands, projectSkills, projectCommands] =
          await Promise.allSettled([
            sendRequest<SkillItem[]>("agentConfig", { section: "skills", scope: "global" }),
            sendRequest<CommandItem[]>("agentConfig", { section: "commands", scope: "global" }),
            workspacePath
              ? sendRequest<SkillItem[]>("agentConfig", {
                  section: "skills",
                  scope: "project",
                  repoPath: workspacePath,
                })
              : Promise.resolve([]),
            workspacePath
              ? sendRequest<CommandItem[]>("agentConfig", {
                  section: "commands",
                  scope: "project",
                  repoPath: workspacePath,
                })
              : Promise.resolve([]),
          ]);

        const items: SlashCommandItem[] = [];
        const seen = new Set<string>();

        // Project items first (they override global ones with the same name)
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

        // Sort skills first, then commands, then alphabetically within each group
        items.sort((a, b) => {
          if (a.kind !== b.kind) {
            return a.kind === "skill" ? -1 : 1;
          }
          return a.name.localeCompare(b.name);
        });
        setAllItems(items);
      } catch (err) {
        console.error("[useSlashCommand] Failed to fetch items:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchItems();
  }, [isOpen, workspacePath]);

  // Filter items by query (client-side fuzzy match)
  const results = useMemo(() => {
    if (!isOpen) return [];
    if (!query) return allItems;

    const lowerQuery = query.toLowerCase();
    return allItems.filter(
      (item) =>
        item.name.toLowerCase().includes(lowerQuery) ||
        item.description.toLowerCase().includes(lowerQuery)
    );
  }, [isOpen, query, allItems]);

  // Reset selected index when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [results.length]);

  // Select an item: replace /query with /name
  const selectItem = useCallback(
    (name: string) => {
      const newValue = `/${name} `;
      onChange(newValue);
      setIsOpen(false);
    },
    [onChange]
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
    isOpen,
    query,
    results,
    loading,
    selectItem,
    dismiss,
    handleKeyDown,
    selectedIndex,
  };
}
