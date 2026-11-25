/**
 * NewTabView — clean start page for a new workspace tab.
 *
 * Applies Fluid Functionalism craft on top of Deus's motion tokens:
 * - Staged `.enter-step` reveal (omnibox → New tool grid → local servers).
 * - Gliding hover highlight (<Glide>) across tool tiles and omnibox results.
 * - Conditional local-server subscription (only mounted when local Browser is enabled).
 */

import { useId, useMemo, useState, useRef, type CSSProperties, type KeyboardEvent } from "react";
import {
  Search,
  Globe,
  X,
  MoreHorizontal,
  Settings2,
  Play,
  ArrowUpRight,
  CornerDownLeft,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Glide } from "@/components/ui/glide";
import { cn } from "@/shared/lib/utils";
import { useSettings } from "@/features/settings/api/settings.queries";
import { openAddressFromChat } from "@/features/session/lib/openFromChat";
import { localFolder } from "@/features/workspace/lib/reach";
import { track } from "@/platform/analytics";
import { useFiles } from "@/features/file-browser/api/useFiles";
import { PierreFileIcon } from "@/features/file-browser/lib/pierreIcons";
import { useFileChanges } from "@/features/workspace/api/workspace.queries";
import { useLocalServers } from "@/features/browser/api/browser.queries";
import { useSimulatorActive } from "@/features/simulator/useSimulatorActive";
import { cloudGateStage } from "@/features/workspace/lib/cloudPresence";
import { locationOf } from "@/features/sidebar/lib/location";
import { uiActions } from "@/shared/stores/uiStore";
import { parseOmniboxUrl, flattenFileTree, searchWorkspaceFiles } from "../lib/omnibox";
import { getVisibleTools, isTabVisible, type ContentTabVisibility } from "../registry";
import type { ContentTab } from "../types";
import type { Workspace } from "@/shared/types";
import type { ProjectTask } from "@shared/types/project-environment";

interface NewTabViewProps {
  workspace: Workspace;
  tabId: string;
  visibility: ContentTabVisibility;
  /** Whether the workspace content pane is visible (gates background file/diff queries). */
  panelVisible?: boolean;
  isWatched?: boolean;
  environmentTasks?: ProjectTask[];
  onRunTask?: (taskName: string) => void;
  onOpenTool: (tool: ContentTab, replaceTabId: string) => void;
  onOpenFile: (path: string, replaceTabId: string) => void;
}

type OmniboxResult =
  | { id: string; kind: "url"; url: string }
  | { id: string; kind: "file"; path: string; name: string; directory: string }
  | { id: string; kind: "tool"; tool: ContentTab; label: string; description: string };

function stepStyle(step: number): CSSProperties {
  return { "--step": step } as CSSProperties;
}

/** Mounted only when the local Browser tab is available so cloud/web modes skip the subscription. */
function RunningLocallyStrip({ onOpenUrl }: { onOpenUrl: (url: string) => void }) {
  const { data } = useLocalServers();
  const servers = data.servers;
  if (servers.length === 0) return null;

  return (
    <div style={stepStyle(2)} className="enter-step mt-6">
      <div className="mb-2 px-0.5">
        <span className="text-text-muted text-xs font-medium">Running locally</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {servers.map((server) => (
          <button
            key={server.url}
            type="button"
            onClick={() => onOpenUrl(server.url)}
            className="control-interaction border-border-subtle/80 bg-bg-raised/45 hover:bg-bg-raised hover:border-border-default flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs"
          >
            <span className="bg-success size-1.5 shrink-0 rounded-full" />
            <span className="text-text-primary font-medium">
              {server.title || `${server.host}:${server.port}`}
            </span>
            <span className="text-text-muted font-mono text-[11px]">:{server.port}</span>
            <ArrowUpRight className="text-text-muted size-3 shrink-0" aria-hidden="true" />
          </button>
        ))}
      </div>
    </div>
  );
}

export function NewTabView({
  workspace,
  tabId,
  visibility,
  panelVisible = true,
  isWatched = false,
  environmentTasks,
  onRunTask,
  onOpenTool,
  onOpenFile,
}: NewTabViewProps) {
  const settings = useSettings().data;
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listboxId = useId();
  const optionDomId = (index: number) => `${listboxId}-option-${index}`;

  const cloud = workspace.kind === "cloud";
  const gateStage = cloudGateStage(workspace);
  const hasQuery = query.trim().length > 0;
  const canQueryFiles = panelVisible && workspace.state === "ready" && !gateStage;

  const browserVisible = isTabVisible("browser", settings, visibility);
  const visibleTools = useMemo(() => getVisibleTools(settings, visibility), [settings, visibility]);

  // Live workspace signals for subtle metadata on tiles
  const { data: filesData } = useFiles(canQueryFiles && hasQuery ? workspace.id : null);
  const { data: changesData } = useFileChanges(canQueryFiles ? workspace : null, isWatched);
  const fileChangesCount = changesData?.files?.length ?? 0;

  const simulatorActive = useSimulatorActive(workspace.id);

  const flatFiles = useMemo(() => flattenFileTree(filesData?.files ?? []), [filesData?.files]);

  // Build ranked omnibox results when query is non-empty
  const results: OmniboxResult[] = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) return [];

    const items: OmniboxResult[] = [];
    const parsedUrl = parseOmniboxUrl(trimmed);

    if (parsedUrl) {
      items.push({ id: `url:${parsedUrl}`, kind: "url", url: parsedUrl });
    }

    const matchedFiles = searchWorkspaceFiles(flatFiles, trimmed, 7);
    for (const file of matchedFiles) {
      items.push({
        id: `file:${file.path}`,
        kind: "file",
        path: file.path,
        name: file.name,
        directory: file.directory,
      });
    }

    const qLower = trimmed.toLowerCase();
    for (const tool of visibleTools) {
      const matches =
        tool.label.toLowerCase().includes(qLower) ||
        tool.keywords.some((kw) => kw.includes(qLower));
      if (matches) {
        items.push({
          id: `tool:${tool.id}`,
          kind: "tool",
          tool: tool.id,
          label: tool.label,
          description: tool.description,
        });
      }
    }

    return items;
  }, [query, flatFiles, visibleTools]);

  const selectedIndex = Math.max(
    0,
    results.findIndex((item) => item.id === selectedId)
  );

  async function openUrl(url: string) {
    const destination = await openAddressFromChat(
      workspace.id,
      url,
      { cloud, folder: localFolder(workspace) },
      { replaceTabId: tabId }
    );
    if (destination === "browser-tab" || destination === "cloud-preview") {
      track("browser_opened", { workspace_id: workspace.id });
    }
  }

  function executeResult(result: OmniboxResult) {
    if (result.kind === "url") {
      void openUrl(result.url);
      return;
    }
    if (result.kind === "file") {
      onOpenFile(result.path, tabId);
      return;
    }
    onOpenTool(result.tool, tabId);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (results.length === 0) return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setSelectedId(results[(selectedIndex + step + results.length) % results.length].id);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const chosen = results[selectedIndex];
      if (chosen) executeResult(chosen);
    } else if (event.key === "Escape") {
      if (query) {
        event.preventDefault();
        setQuery("");
      }
    }
  }

  return (
    <div
      data-slot="new-tab-view"
      className="@container flex h-full w-full flex-col overflow-y-auto px-6 py-10"
    >
      <div className="mx-auto my-auto flex w-full max-w-[520px] flex-col">
        {/* Centered pill omnibox */}
        <div style={stepStyle(0)} className="enter-step relative">
          <div
            className={cn(
              "bg-input-surface border-border-default flex h-11 items-center gap-2.5 rounded-full border px-4 shadow-xs transition-[border-color,box-shadow] dark:shadow-none",
              "focus-within:border-border-strong focus-within:ring-primary/20 focus-within:ring-2"
            )}
          >
            <Search className="text-text-muted size-4 shrink-0" aria-hidden="true" />
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-expanded={hasQuery}
              aria-controls={listboxId}
              aria-autocomplete="list"
              aria-activedescendant={
                hasQuery && results[selectedIndex] ? optionDomId(selectedIndex) : undefined
              }
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelectedId(null);
              }}
              onKeyDown={handleKeyDown}
              placeholder="Search files or enter a URL"
              aria-label="Search files or enter a URL"
              autoComplete="off"
              spellCheck={false}
              data-1p-ignore
              className="text-text-primary placeholder:text-text-muted min-w-0 flex-1 bg-transparent text-sm outline-none"
            />
            {hasQuery && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => {
                  setQuery("");
                  setSelectedId(null);
                  inputRef.current?.focus();
                }}
                className="control-interaction text-text-muted hover:text-text-secondary hover:bg-control-hover flex size-5 shrink-0 items-center justify-center rounded-full"
              >
                <X className="size-3" aria-hidden="true" />
              </button>
            )}
          </div>

          {/* Instant search results with gliding selection fill */}
          {hasQuery && (
            <div
              id={listboxId}
              role="listbox"
              aria-label="Search results"
              className="bg-popover border-border-subtle animate-fade-in relative isolate mt-2 overflow-hidden rounded-xl border p-1 shadow-md"
            >
              <Glide follow="data-selected" className="bg-control-hover rounded-lg" />
              {results.length > 0 ? (
                results.map((item, index) => {
                  const selected = index === selectedIndex;
                  return (
                    <button
                      key={item.id}
                      id={optionDomId(index)}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      data-selected={selected ? "true" : undefined}
                      onMouseEnter={() => setSelectedId(item.id)}
                      onClick={() => executeResult(item)}
                      className={cn(
                        "relative flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
                        selected ? "text-text-primary" : "text-text-secondary"
                      )}
                    >
                      {item.kind === "url" ? (
                        <>
                          <Globe className="text-text-muted size-4 shrink-0" aria-hidden="true" />
                          <span className="min-w-0 flex-1 truncate font-medium">{item.url}</span>
                          <CornerDownLeft
                            className="text-text-disabled size-3.5 shrink-0"
                            aria-hidden="true"
                          />
                        </>
                      ) : item.kind === "file" ? (
                        <>
                          <PierreFileIcon fileName={item.name} size={15} className="shrink-0" />
                          <span className="shrink-0 font-medium">{item.name}</span>
                          {item.directory && (
                            <span className="text-text-muted min-w-0 flex-1 truncate text-xs">
                              {item.directory}
                            </span>
                          )}
                        </>
                      ) : (
                        <>
                          {(() => {
                            const toolDef = visibleTools.find((t) => t.id === item.tool);
                            const Icon = toolDef?.icon ?? Globe;
                            return (
                              <Icon
                                className="text-text-muted size-4 shrink-0"
                                aria-hidden="true"
                              />
                            );
                          })()}
                          <span className="font-medium">{item.label}</span>
                          <span className="text-text-muted min-w-0 flex-1 truncate text-xs">
                            {item.description}
                          </span>
                        </>
                      )}
                    </button>
                  );
                })
              ) : (
                <div className="text-text-muted px-3 py-6 text-center text-xs">
                  No matching files or tools
                </div>
              )}
            </div>
          )}
        </div>

        {/* New tab tool grid with gliding hover highlight */}
        {!hasQuery && (
          <>
            <div style={stepStyle(1)} className="enter-step mt-7">
              <div className="mb-2.5 flex items-center justify-between px-0.5">
                <span className="text-text-muted text-xs font-medium">New</span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label="Workspace actions"
                      className="control-interaction text-text-muted hover:text-text-secondary hover:bg-control-hover flex size-6 items-center justify-center rounded-md"
                    >
                      <MoreHorizontal className="size-3.5" aria-hidden="true" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[180px]">
                    {environmentTasks && environmentTasks.length > 0 && onRunTask && (
                      <>
                        {environmentTasks.map((task) => (
                          <DropdownMenuItem
                            key={task.name}
                            onClick={() => onRunTask(task.name)}
                            className="gap-2 text-xs"
                          >
                            <Play className="size-3" aria-hidden="true" />
                            <span>Run {task.name}</span>
                          </DropdownMenuItem>
                        ))}
                        <DropdownMenuSeparator />
                      </>
                    )}
                    <DropdownMenuItem
                      onClick={() =>
                        uiActions.openEnvironmentSettings(
                          workspace.repository_id,
                          locationOf(workspace)
                        )
                      }
                      className="gap-2 text-xs"
                    >
                      <Settings2 className="size-3.5" aria-hidden="true" />
                      <span>Environment settings</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              <div
                className={cn(
                  "relative isolate grid grid-cols-2 gap-2.5",
                  visibleTools.length <= 4 ? "@[420px]:grid-cols-4" : "@[380px]:grid-cols-3"
                )}
              >
                <Glide
                  rows='[data-slot="new-tab-tile"]'
                  className="bg-bg-raised ring-border-default rounded-xl ring-1 ring-inset"
                />
                {visibleTools.map((tool) => {
                  const Icon = tool.icon;
                  const showChangesCount = tool.id === "changes" && fileChangesCount > 0;
                  const showSimDot = tool.id === "simulator" && simulatorActive;

                  return (
                    <button
                      key={tool.id}
                      type="button"
                      data-slot="new-tab-tile"
                      onClick={() => onOpenTool(tool.id, tabId)}
                      className={cn(
                        "control-interaction group border-border-subtle/70 bg-bg-raised/45 active:bg-control-surface-pressed hover:bg-transparent",
                        "relative flex h-[84px] cursor-pointer flex-col justify-between rounded-xl border p-3 text-left"
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <Icon
                          className="text-text-secondary group-hover:text-text-primary size-4 transition-colors"
                          aria-hidden="true"
                        />
                        {showChangesCount && (
                          <span
                            aria-hidden="true"
                            className="bg-bg-muted text-text-secondary rounded-md px-1.5 py-0.5 text-[10px] leading-none font-medium tabular-nums"
                          >
                            {fileChangesCount}
                          </span>
                        )}
                        {showSimDot && (
                          <span aria-hidden="true" className="bg-success size-2 rounded-full" />
                        )}
                      </div>
                      <span className="text-text-primary text-sm font-medium">{tool.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {panelVisible && !cloud && browserVisible && (
              <RunningLocallyStrip onOpenUrl={openUrl} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
