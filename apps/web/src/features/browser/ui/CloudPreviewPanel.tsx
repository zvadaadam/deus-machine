/**
 * CloudPreviewPanel — the Browser tab on a cloud computer.
 *
 * A local workspace's Browser previews `localhost:PORT`; a cloud computer's
 * ports live inside the sandbox. agnt publishes the sandbox's host template,
 * so the preview is the same webview pointed at `https://{port}-<id>.e2b.app`.
 * The user names the port (their dev server must bind 0.0.0.0 — E2B's edge
 * routes to the sandbox's network interface, not its loopback).
 *
 * One BrowserTab per URL: changing the port remounts the tab, which is the
 * simplest correct way to get a fresh navigation without reaching into the
 * webview's history model. See lib/cloudPreview.ts for the v1 posture.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/shared/lib/utils";
import type { Workspace } from "@/shared/types";
import { BrowserTab } from "./BrowserTab";
import { createBrowserTab, type BrowserTabState } from "../types";
import { webviewManager } from "../webview-manager";
import {
  CLOUD_PREVIEW_QUICK_PORTS,
  normalizePreviewPort,
  readStoredPreviewPort,
  resolveCloudPreviewUrl,
  storePreviewPort,
} from "../lib/cloudPreview";

interface CloudPreviewPanelProps {
  workspace: Workspace;
  visible: boolean;
}

function previewTab(workspaceId: string, url: string): BrowserTabState {
  const tab = createBrowserTab(workspaceId);
  return { ...tab, title: "Preview", url, currentUrl: url, history: [url], historyIndex: 0 };
}

export function CloudPreviewPanel({ workspace, visible }: CloudPreviewPanelProps) {
  const [port, setPort] = useState(() => readStoredPreviewPort(workspace.id));
  const [draft, setDraft] = useState(String(port));
  const [generation, setGeneration] = useState(0);

  const url = useMemo(
    () => resolveCloudPreviewUrl(workspace.cloud_preview_template, port),
    [workspace.cloud_preview_template, port]
  );

  // A tab per (url, generation): the port field and Reload both remount.
  const [tab, setTab] = useState<BrowserTabState | null>(null);
  useEffect(() => {
    if (!url) {
      setTab(null);
      return;
    }
    const next = previewTab(workspace.id, url);
    setTab(next);
    return () => webviewManager.dispose(next.id);
  }, [workspace.id, url, generation]);

  const applyPort = useCallback(
    (value: string | number) => {
      const next = normalizePreviewPort(value);
      if (next === null) {
        setDraft(String(port));
        return;
      }
      setDraft(String(next));
      storePreviewPort(workspace.id, next);
      setPort(next);
    },
    [port, workspace.id]
  );

  const onUpdateTab = useCallback((tabId: string, updates: Partial<BrowserTabState>) => {
    setTab((prev) => (prev && prev.id === tabId ? { ...prev, ...updates } : prev));
  }, []);

  return (
    <div className="bg-bg-base flex h-full w-full min-w-0 flex-col">
      <div className="border-border-subtle flex h-10 flex-shrink-0 items-center gap-2 border-b px-2">
        <span className="text-text-muted text-xs">Port</span>
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => applyPort(draft)}
          onKeyDown={(e) => {
            if (e.key === "Enter") applyPort(draft);
          }}
          inputMode="numeric"
          aria-label="Dev server port inside the cloud computer"
          className="h-7 w-20 text-xs"
        />
        <div className="flex items-center gap-1">
          {CLOUD_PREVIEW_QUICK_PORTS.map((quick) => (
            <button
              key={quick}
              type="button"
              onClick={() => applyPort(quick)}
              className={cn(
                "rounded-md px-1.5 py-0.5 text-[11px] transition-colors duration-150",
                quick === port
                  ? "bg-bg-muted text-text-primary"
                  : "text-text-muted hover:text-text-secondary hover:bg-bg-muted/50"
              )}
            >
              {quick}
            </button>
          ))}
        </div>
        <span className="text-text-disabled min-w-0 flex-1 truncate font-mono text-[11px]">
          {url ?? "waiting for the computer's address…"}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2"
          onClick={() => setGeneration((g) => g + 1)}
          disabled={!url}
          aria-label="Reload preview"
        >
          <RotateCw className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2"
          onClick={() => url && window.open(url, "_blank", "noopener")}
          disabled={!url}
          aria-label="Open preview in your browser"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">
        {tab ? (
          <BrowserTab
            key={tab.id}
            tab={tab}
            onUpdateTab={onUpdateTab}
            onAddLog={() => {}}
            visible={visible}
          />
        ) : (
          <div className="text-text-muted flex h-full items-center justify-center px-6 text-center text-xs">
            The computer hasn't reported its address yet — it appears once the sandbox is running.
          </div>
        )}
      </div>
      <p className="text-text-disabled border-border-subtle border-t px-3 py-1.5 text-[11px]">
        Your dev server must listen on <span className="font-mono">0.0.0.0</span>, not localhost —
        the cloud computer's edge routes to its network interface.
      </p>
    </div>
  );
}
