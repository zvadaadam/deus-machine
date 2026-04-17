/**
 * FileMentionPopover — Sheet list of file search results for @ mentions
 *
 * Renders inside the InputGroup as a sheet that slides out above the textarea
 * when the user types @ to mention a file. Matches the SlashCommandPopover style.
 */

import { useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";
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

/** Highlight matched substring in filename */
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
    const selectedEl = listRef.current.querySelector<HTMLElement>('[data-selected="true"]');
    selectedEl?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (results.length === 0 && !loading) {
    return (
      <div className="border-border/50 bg-muted/20 w-full border-b">
        <div className="text-foreground/80 px-4 py-3 text-sm font-medium">Files</div>
        <div className="px-4 pb-4">
          <p className="text-muted-foreground text-xs">
            {query ? "No files found" : "Type to search files"}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="border-border/50 bg-muted/20 w-full border-b">
      <div className="text-foreground/80 px-4 py-3 text-sm font-medium">Files</div>

      {loading && results.length === 0 ? (
        <div className="text-muted-foreground flex items-center gap-1.5 px-4 pb-4 text-xs">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>Searching...</span>
        </div>
      ) : (
        <div ref={listRef} className="max-h-[320px] overflow-y-auto px-2 pb-2">
          {results.map((result, index) => {
            const dir = getDirectory(result.path);
            const isSelected = index === selectedIndex;

            return (
              <button
                type="button"
                key={result.path}
                data-selected={isSelected ? "true" : undefined}
                className={cn(
                  "flex w-full items-start rounded-xl px-3 py-2 text-left transition-colors duration-150 ease-out",
                  isSelected ? "bg-accent text-accent-foreground" : "hover:bg-accent/40"
                )}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect(result.path);
                }}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className={cn(
                        "text-muted-foreground shrink-0 text-sm leading-none",
                        isSelected && "text-accent-foreground/65"
                      )}
                    >
                      @
                    </span>
                    <div className="truncate text-sm leading-tight font-medium">
                      {highlightMatch(result.name, query)}
                    </div>
                    {dir && (
                      <span
                        className={cn(
                          "text-muted-foreground min-w-0 truncate text-xs",
                          isSelected && "text-accent-foreground/60"
                        )}
                      >
                        {dir}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
