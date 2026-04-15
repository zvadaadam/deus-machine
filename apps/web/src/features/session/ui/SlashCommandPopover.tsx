/**
 * SlashCommandPopover — Sheet list of available skills & commands
 *
 * Renders inside the InputGroup as a sheet that slides out above the textarea
 * when the user types `/` to invoke a skill or command.
 */

import { useEffect, useMemo, useRef } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import type { SlashCommandItem } from "../hooks/useSlashCommand";

interface SlashCommandPopoverProps {
  results: SlashCommandItem[];
  loading: boolean;
  selectedIndex: number;
  query: string;
  onSelect: (name: string) => void;
}

interface SlashCommandSection {
  title: string;
  items: SlashCommandItem[];
  startIndex: number;
}

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
  results,
  loading,
  selectedIndex,
  query,
  onSelect,
}: SlashCommandPopoverProps) {
  const listRef = useRef<HTMLDivElement>(null);

  const skillItems = useMemo(() => results.filter((item) => item.kind === "skill"), [results]);
  const commandItems = useMemo(() => results.filter((item) => item.kind === "command"), [results]);

  const headerTitle =
    skillItems.length > 0 ? "Skills" : commandItems.length > 0 ? "Commands" : "Skills & commands";

  const sections = useMemo<SlashCommandSection[]>(() => {
    const nextSections: SlashCommandSection[] = [];
    let startIndex = 0;

    if (skillItems.length > 0) {
      nextSections.push({ title: "Skills", items: skillItems, startIndex });
      startIndex += skillItems.length;
    }

    if (commandItems.length > 0) {
      nextSections.push({ title: "Commands", items: commandItems, startIndex });
    }

    return nextSections;
  }, [commandItems, skillItems]);

  useEffect(() => {
    if (!listRef.current) return;
    const selectedEl = listRef.current.querySelector<HTMLElement>('[data-selected="true"]');
    selectedEl?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (results.length === 0 && !loading) {
    if (!query) return null;
    return (
      <div className="border-border/50 bg-muted/20 w-full border-b">
        <div className="text-foreground/80 px-4 py-3 text-sm font-medium">{headerTitle}</div>
        <div className="px-4 pb-4">
          <p className="text-muted-foreground text-xs">No matching skills or commands</p>
        </div>
      </div>
    );
  }

  return (
    <div className="border-border/50 bg-muted/20 w-full border-b">
      <div className="text-foreground/80 px-4 py-3 text-sm font-medium">{headerTitle}</div>

      {loading && results.length === 0 ? (
        <div className="text-muted-foreground flex items-center gap-1.5 px-4 pb-4 text-xs">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>Loading skills...</span>
        </div>
      ) : (
        <div ref={listRef} className="max-h-[320px] overflow-y-auto px-2 pb-2">
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
                      key={`${item.kind}-${item.name}`}
                      data-selected={isSelected ? "true" : undefined}
                      className={cn(
                        "flex w-full items-start rounded-xl px-3 py-2 text-left transition-colors duration-150 ease-out",
                        isSelected ? "bg-accent text-accent-foreground" : "hover:bg-accent/40"
                      )}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        onSelect(item.name);
                      }}
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
    </div>
  );
}
