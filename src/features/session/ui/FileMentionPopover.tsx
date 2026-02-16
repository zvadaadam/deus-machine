/**
 * FileMentionPopover — Floating file search results for @ mentions
 *
 * Renders a compact popover anchored above the textarea when the user
 * types @ to mention a file. Uses the same visual language as the
 * command palette but in a lightweight inline popover.
 */

import { useEffect, useRef } from "react";
import { File, Loader2 } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import type { FuzzyFileResult } from "../hooks/useFileMention";

interface FileMentionPopoverProps {
  results: FuzzyFileResult[];
  loading: boolean;
  selectedIndex: number;
  query: string;
  onSelect: (filePath: string) => void;
}

/** Extract the directory portion of a path, or empty string */
function getDirectory(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  return lastSlash > 0 ? path.slice(0, lastSlash) : "";
}

/** Highlight matched characters in filename (simple substring highlight) */
function highlightMatch(text: string, query: string) {
  if (!query) return text;

  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const index = lowerText.indexOf(lowerQuery);

  if (index === -1) return text;

  return (
    <>
      {text.slice(0, index)}
      <span className="text-foreground font-medium">{text.slice(index, index + query.length)}</span>
      {text.slice(index + query.length)}
    </>
  );
}

export function FileMentionPopover({
  results,
  loading,
  selectedIndex,
  query,
  onSelect,
}: FileMentionPopoverProps) {
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const selectedEl = listRef.current.children[selectedIndex] as HTMLElement | undefined;
    selectedEl?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (results.length === 0 && !loading) {
    if (!query) return null;
    return (
      <div className="border-border/50 bg-popover/95 w-[360px] rounded-lg border p-3 shadow-lg backdrop-blur-xl">
        <p className="text-muted-foreground text-center text-xs">No files found</p>
      </div>
    );
  }

  return (
    <div className="border-border/50 bg-popover/95 w-[360px] overflow-hidden rounded-lg border shadow-lg backdrop-blur-xl">
      {loading && results.length === 0 && (
        <div className="flex items-center justify-center gap-2 p-3">
          <Loader2 className="text-muted-foreground h-3.5 w-3.5 animate-spin" />
          <span className="text-muted-foreground text-xs">Searching...</span>
        </div>
      )}

      <div ref={listRef} className="max-h-[240px] overflow-y-auto py-1">
        {results.map((result, index) => {
          const dir = getDirectory(result.path);
          const isSelected = index === selectedIndex;

          return (
            <button
              key={result.path}
              className={cn(
                "flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors duration-75",
                isSelected
                  ? "bg-accent text-accent-foreground"
                  : "text-foreground hover:bg-accent/50"
              )}
              onMouseDown={(e) => {
                // Use mouseDown (not click) to fire before textarea blur
                e.preventDefault();
                onSelect(result.path);
              }}
            >
              <File className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <span className="text-[13px] leading-tight">
                  {highlightMatch(result.name, query)}
                </span>
                {dir && <span className="text-muted-foreground ml-1.5 text-[11px]">{dir}</span>}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
