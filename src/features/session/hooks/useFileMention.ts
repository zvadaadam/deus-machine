/**
 * useFileMention — Detects `@` trigger in textarea and drives fuzzy file search
 *
 * Watches the current input value and cursor position to detect when the user
 * types `@` to start a file mention. Extracts the search query (text after @)
 * and calls the Rust fuzzy_file_search Tauri command for nucleo-powered results.
 *
 * Returns state and handlers that the MessageInput and FileMentionPopover consume.
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@/platform/tauri";

export interface FuzzyFileResult {
  path: string;
  name: string;
  score: number;
}

interface UseFileMentionOptions {
  /** Current textarea value */
  value: string;
  /** Workspace path for file search scope */
  workspacePath: string | null;
  /** Callback to update the textarea value after inserting a mention */
  onChange: (newValue: string) => void;
}

interface UseFileMentionReturn {
  /** Whether the mention popover should be open */
  isOpen: boolean;
  /** The search query extracted from text after @ */
  query: string;
  /** Fuzzy search results from Rust/nucleo */
  results: FuzzyFileResult[];
  /** Whether a search is in progress */
  loading: boolean;
  /** Call when user selects a file from the popover */
  selectFile: (filePath: string) => void;
  /** Call to dismiss the popover */
  dismiss: () => void;
  /** Attach to textarea's onKeyDown for arrow/enter/escape handling */
  handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** Attach to textarea's onSelect/onClick to track cursor position */
  handleCursorChange: (e: React.SyntheticEvent<HTMLTextAreaElement>) => void;
  /** Index of currently highlighted result (for keyboard navigation) */
  selectedIndex: number;
}

/**
 * Find the @ trigger position relative to the cursor.
 * Returns the index of @ if the cursor is inside an @mention, or -1.
 *
 * An @mention is active when:
 * - There's an `@` character before the cursor
 * - The `@` is either at position 0 or preceded by whitespace
 * - No whitespace between `@` and cursor (the query is a single "word")
 */
function findMentionTrigger(value: string, cursorPos: number): number {
  // Search backwards from cursor for @
  const beforeCursor = value.slice(0, cursorPos);

  // Find the last @ before cursor
  const atIndex = beforeCursor.lastIndexOf("@");
  if (atIndex === -1) return -1;

  // @ must be at start of input or preceded by whitespace/newline
  if (atIndex > 0 && !/\s/.test(value[atIndex - 1])) return -1;

  // Text between @ and cursor must not contain spaces (single token query)
  const queryText = value.slice(atIndex + 1, cursorPos);
  if (/\s/.test(queryText)) return -1;

  return atIndex;
}

export function useFileMention({
  value,
  workspacePath,
  onChange,
}: UseFileMentionOptions): UseFileMentionReturn {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FuzzyFileResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [cursorPos, setCursorPos] = useState(0);

  // Track the @ trigger position for replacement on selection
  const triggerIndexRef = useRef(-1);

  // Debounce timer for search
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track cursor position changes
  const handleCursorChange = useCallback(
    (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
      const textarea = e.currentTarget;
      setCursorPos(textarea.selectionStart);
    },
    []
  );

  // Detect @mention trigger whenever value or cursor changes
  useEffect(() => {
    const atIndex = findMentionTrigger(value, cursorPos);

    if (atIndex >= 0 && workspacePath) {
      triggerIndexRef.current = atIndex;
      const newQuery = value.slice(atIndex + 1, cursorPos);
      setQuery(newQuery);
      setIsOpen(true);
      setSelectedIndex(0);
    } else {
      setIsOpen(false);
      setQuery("");
      triggerIndexRef.current = -1;
    }
  }, [value, cursorPos, workspacePath]);

  // Search when query changes (debounced)
  useEffect(() => {
    if (!isOpen || !workspacePath) {
      setResults([]);
      return;
    }

    // Clear previous timer
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current);
    }

    // Empty query → no results
    if (!query) {
      setResults([]);
      setLoading(false);
      return;
    }

    setLoading(true);

    // Debounce search by 80ms to avoid hammering Tauri on every keystroke
    searchTimerRef.current = setTimeout(async () => {
      try {
        const searchResults = await invoke<FuzzyFileResult[]>(
          "fuzzy_file_search",
          { workspacePath, query, limit: 15 }
        );
        setResults(searchResults);
      } catch (err) {
        console.error("[useFileMention] Search failed:", err);
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 80);

    return () => {
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current);
      }
    };
  }, [query, isOpen, workspacePath]);

  // Select a file: replace @query with the file path
  const selectFile = useCallback(
    (filePath: string) => {
      const atIndex = triggerIndexRef.current;
      if (atIndex === -1) return;

      // Replace @query with @filepath (keep the @ prefix for visibility)
      const before = value.slice(0, atIndex);
      const after = value.slice(cursorPos);
      const mention = `@${filePath} `;
      const newValue = before + mention + after;

      onChange(newValue);
      setIsOpen(false);
      setQuery("");
      triggerIndexRef.current = -1;
    },
    [value, cursorPos, onChange]
  );

  // Dismiss the popover
  const dismiss = useCallback(() => {
    setIsOpen(false);
    setQuery("");
    triggerIndexRef.current = -1;
  }, []);

  // Keyboard navigation for the popover
  // Returns true if the event was handled (caller should preventDefault)
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
          // Don't consume Cmd+Enter (that's "send message")
          if (e.metaKey || e.ctrlKey) return false;
          const selected = results[selectedIndex];
          if (selected) {
            selectFile(selected.path);
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
    [isOpen, results, selectedIndex, selectFile, dismiss]
  );

  return {
    isOpen,
    query,
    results,
    loading,
    selectFile,
    dismiss,
    handleKeyDown,
    handleCursorChange,
    selectedIndex,
  };
}
