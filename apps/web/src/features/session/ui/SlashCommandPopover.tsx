import { useEffect, useMemo, useRef } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { Glide } from "@/components/ui/glide";
import type { SlashCommandItem } from "../hooks/useSlashCommand";

interface SlashCommandPopoverProps {
  listId: string;
  getOptionId: (value: string) => string;
  results: SlashCommandItem[];
  loading: boolean;
  selectedIndex: number;
  query: string;
  onHighlight: (index: number) => void;
  onSelect: (name: string) => void;
}

interface SlashCommandSection {
  title: string;
  items: SlashCommandItem[];
  startIndex: number;
}

const sectionTitles = { action: "Actions", skill: "Skills", command: "Commands" };

/** Highlight matched substring in item name */
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

export function SlashCommandPopover({
  listId,
  getOptionId,
  results,
  loading,
  selectedIndex,
  query,
  onHighlight,
  onSelect,
}: SlashCommandPopoverProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const pointerRow = useRef<HTMLButtonElement | null>(null);

  const sections = useMemo<SlashCommandSection[]>(() => {
    const groups: SlashCommandSection[] = [];
    for (const [index, item] of results.entries()) {
      const title = sectionTitles[item.kind];
      const last = groups.at(-1);
      if (last?.title === title) last.items.push(item);
      else groups.push({ title, items: [item], startIndex: index });
    }
    return groups;
  }, [results]);
  const headerTitle = sections[0]?.title ?? "Skills & commands";

  useEffect(() => {
    if (!listRef.current) return;
    const selectedEl = listRef.current.querySelector<HTMLElement>('[aria-selected="true"]');
    if (selectedEl !== pointerRow.current) selectedEl?.scrollIntoView({ block: "nearest" });
    pointerRow.current = null;
  }, [selectedIndex, results]);

  return (
    <>
      <div className="text-foreground/80 shrink-0 px-4 py-3 text-sm font-medium">{headerTitle}</div>

      {results.length === 0 ? (
        <div
          role="status"
          className="text-muted-foreground flex items-center gap-1.5 px-4 pb-4 text-xs"
        >
          {loading && <Loader2 className="h-3 w-3 animate-spin" />}
          {loading ? "Loading skills..." : "No matching skills or commands"}
        </div>
      ) : (
        <div
          ref={listRef}
          role="listbox"
          id={listId}
          aria-label="Skills and commands"
          className="relative isolate min-h-0 overflow-y-auto overscroll-contain px-2 pb-2"
        >
          <Glide
            follow="aria-selected"
            className="bg-accent dark:bg-control-surface-pressed rounded-lg"
          />
          {sections.map((section, sectionIndex) => {
            const showSectionLabel = section.title !== headerTitle || sectionIndex > 0;

            return (
              <div
                key={section.title}
                className={cn(sectionIndex > 0 && "border-border/40 mt-1 border-t pt-1")}
              >
                {showSectionLabel && (
                  <div className="text-muted-foreground px-3 pt-2 pb-1 text-[11px] font-medium tracking-[0.08em] uppercase">
                    {section.title}
                  </div>
                )}

                {section.items.map((item, index) => {
                  const itemIndex = section.startIndex + index;
                  const isSelected = itemIndex === selectedIndex;

                  return (
                    <button
                      type="button"
                      key={`${item.kind}-${item.name}`}
                      role="option"
                      tabIndex={-1}
                      id={getOptionId(item.name)}
                      aria-selected={isSelected}
                      className={cn(
                        "control-interaction flex w-full items-start rounded-lg px-3 py-2 text-left",
                        isSelected && "text-accent-foreground"
                      )}
                      onPointerMove={(event) => {
                        if (event.pointerType !== "touch" && !isSelected) {
                          pointerRow.current = event.currentTarget;
                          onHighlight(itemIndex);
                        }
                      }}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => onSelect(item.name)}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <span
                              className={cn(
                                "text-muted-foreground shrink-0 text-sm leading-none",
                                isSelected && "text-accent-foreground/65"
                              )}
                            >
                              /
                            </span>
                            <div className="truncate text-sm leading-tight font-medium">
                              {highlightMatch(item.name, query)}
                            </div>
                          </div>
                          {item.description && (
                            <div
                              className={cn(
                                "text-muted-foreground min-w-0 flex-1 truncate pl-6 text-xs leading-tight sm:pl-0 sm:text-[13px]",
                                isSelected && "text-accent-foreground/70"
                              )}
                            >
                              {item.description}
                            </div>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
