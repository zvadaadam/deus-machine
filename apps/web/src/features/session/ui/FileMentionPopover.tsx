import { useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import type { FuzzyFileResult } from "../hooks/useFileMention";

interface FileMentionPopoverProps {
  listId: string;
  getOptionId: (value: string) => string;
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
  listId,
  getOptionId,
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
    const selectedEl = listRef.current.querySelector<HTMLElement>('[aria-selected="true"]');
    selectedEl?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  return (
    <>
      <div className="text-foreground/80 shrink-0 px-4 py-3 text-sm font-medium">Files</div>

      {results.length === 0 ? (
        <div
          role="status"
          className="text-muted-foreground flex items-center gap-1.5 px-4 pb-4 text-xs"
        >
          {loading && <Loader2 className="h-3 w-3 animate-spin" />}
          {loading ? "Searching..." : query ? "No files found" : "Type to search files"}
        </div>
      ) : (
        <div
          ref={listRef}
          role="listbox"
          id={listId}
          aria-label="Files"
          className="min-h-0 overflow-y-auto overscroll-contain px-2 pb-2"
        >
          {results.map((result, index) => {
            const dir = getDirectory(result.path);
            const isSelected = index === selectedIndex;

            return (
              <button
                type="button"
                key={result.path}
                role="option"
                tabIndex={-1}
                id={getOptionId(result.path)}
                aria-selected={isSelected}
                className={cn(
                  "control-interaction flex w-full items-start rounded-lg px-3 py-2 text-left",
                  isSelected
                    ? "bg-accent dark:bg-control-surface-pressed text-accent-foreground"
                    : "hover:bg-accent/40"
                )}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onSelect(result.path)}
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
    </>
  );
}
