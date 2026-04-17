/**
 * useFileMention — Detects `@` trigger in textarea and drives fuzzy file search
 *
 * Watches the current input value and cursor position to detect when the user
 * types `@` to start a file mention. Extracts the search query (text after @)
 * and calls the backend HTTP endpoint for fuzzy file search results.
 *
 * Returns state and handlers that the MessageInput and FileMentionPopover consume.
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { sendRequest } from "@/platform/ws";

export interface FuzzyFileResult {
  path: string;
  name: string;
  score: number;
}

interface UseFileMentionOptions {
  /** Current textarea value */
  value: string;
  /** Workspace ID for the backend file search endpoint */
  workspaceId: string | null;
  /** Callback to update the textarea value after inserting a mention */
  onChange: (newValue: string) => void;
  /**
   * When provided, selecting a file adds a structured mention via this callback
   * instead of inserting `@path ` text inline. The `@query` the user typed is
   * removed from the textarea, and the file is surfaced as a pill above it.
   */
  onAddMention?: (result: FuzzyFileResult) => void;
}

interface UseFileMentionReturn {
  /** Whether the mention popover should be open */
  isOpen: boolean;
  /** The search query extracted from text after @ */
  query: string;
  /** Fuzzy search results from backend HTTP endpoint */
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
  workspaceId,
  onChange,
  onAddMention,
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

  // Monotonic search ID — discard results from stale HTTP calls when the user
  // types faster than the debounce + HTTP round-trip (e.g. "@fo" → "@foo").
  const searchIdRef = useRef(0);

  // Track cursor position changes
  const handleCursorChange = useCallback((e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const textarea = e.currentTarget;
    setCursorPos(textarea.selectionStart);
  }, []);

  // Detect @mention trigger whenever value or cursor changes
  useEffect(() => {
    const atIndex = findMentionTrigger(value, cursorPos);

    if (atIndex >= 0 && workspaceId) {
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
  }, [value, cursorPos, workspaceId]);

  // Search when query changes (debounced)
  useEffect(() => {
    if (!isOpen || !workspaceId) {
      setResults([]);
      return;
    }

    // Clear previous timer
    if (searchTimerRef.current) {
      clearTimeout(searchTimerRef.current);
    }

    setLoading(true);

    // Bump search ID so in-flight HTTP calls from earlier keystrokes are discarded
    const currentSearchId = ++searchIdRef.current;

    // Debounce search by 80ms to avoid hammering the backend on every keystroke
    // Empty query is sent immediately (no debounce) to show default files fast
    const delay = query ? 80 : 0;

    searchTimerRef.current = setTimeout(async () => {
      try {
        const searchResults = await sendRequest<FuzzyFileResult[]>("fileSearch", {
          workspaceId,
          query: query || "",
          limit: 15,
        });
        // Only apply results if this is still the latest search
        if (searchIdRef.current !== currentSearchId) return;
        setResults(searchResults);
      } catch (err) {
        if (searchIdRef.current !== currentSearchId) return;
        console.error("[useFileMention] Search failed:", err);
        setResults([]);
      } finally {
        if (searchIdRef.current === currentSearchId) {
          setLoading(false);
        }
      }
    }, delay);

    return () => {
      if (searchTimerRef.current) {
        clearTimeout(searchTimerRef.current);
      }
    };
  }, [query, isOpen, workspaceId]);

  // Select a file: either add as a structured pill (pill mode) or insert inline text
  const selectFile = useCallback(
    (filePath: string) => {
      const atIndex = triggerIndexRef.current;
      if (atIndex === -1) return;

      const before = value.slice(0, atIndex);
      const after = value.slice(cursorPos);

      if (onAddMention) {
        // Pill mode: remove the @query the user typed, surface mention above input.
        // Derive the result from filePath directly — the results array may have
        // mutated between render and click (async search), so find() can miss.
        // Falling back to a synthesized result guarantees we never clear the
        // @query without also surfacing a pill.
        const fromResults = results.find((r) => r.path === filePath);
        const result = fromResults ?? {
          path: filePath,
          name: filePath.split("/").pop() || filePath,
          score: 0,
        };
        onAddMention(result);
        const newValue = before + after;
        const newCursorPos = before.length;
        setCursorPos(newCursorPos);
        onChange(newValue);
      } else {
        // Text mode: insert @filepath inline (legacy behavior)
        const mention = `@${filePath} `;
        const newValue = before + mention + after;
        // Update cursorPos BEFORE onChange so the detection effect (which depends
        // on [value, cursorPos]) sees the new cursor after the mention. Without
        // this, cursorPos stays stale and findMentionTrigger re-detects the @
        // inside the inserted text, immediately reopening the popover.
        const newCursorPos = before.length + mention.length;
        setCursorPos(newCursorPos);
        onChange(newValue);
      }

      setIsOpen(false);
      setQuery("");
      triggerIndexRef.current = -1;
    },
    [value, cursorPos, onChange, onAddMention, results]
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
