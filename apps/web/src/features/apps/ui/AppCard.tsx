/**
 * One card for an installed agentic app. Shows icon + name + description +
 * a status chip and a primary action button.
 *
 * Primary action semantics:
 *   idle       → "Launch"  — sends the `launchApp` q:command
 *   starting   → "Starting..." disabled — chip shows the same state
 *   ready      → "Open"    — focuses the Browser tab at the app URL
 *   stopping   → "Stop" disabled — confirms the in-flight stop
 *
 * The overflow menu carries "Stop" when the app is running so the user
 * can terminate without waiting for the idle transition.
 *
 * v1 limitation: manifest.icon is ignored. Manifest icons live inside the
 * package directory (e.g. packages/device-use/assets/icon.svg) which the
 * frontend can't reach over the WS boundary. Always render a lucide
 * LayoutGrid fallback — we can add a bundled icon asset pipeline later.
 */

import { useCallback, useState } from "react";
import { LayoutGrid, MoreHorizontal, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { sendCommand } from "@/platform/ws/query-protocol-client";
import { browserWindowActions } from "@/features/browser/store/browserWindowStore";
import { workspaceLayoutActions } from "@/features/workspace/store/workspaceLayoutStore";
import { cn } from "@/shared/lib/utils";
import type { InstalledApp, RunningApp } from "@shared/aap/types";
import { AppStatusChip, type AppChipStatus } from "./AppStatusChip";

interface AppCardProps {
  app: InstalledApp;
  /** Current running entry for this app in this workspace (if any). */
  running: RunningApp | null;
  /** Always non-null when this card is visible (AppsLauncher gates on it). */
  workspaceId: string;
}

export function AppCard({ app, running, workspaceId }: AppCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chipStatus: AppChipStatus = running?.status ?? "idle";
  const isRunning = running?.status === "ready";
  const isTransitioning = running?.status === "starting" || running?.status === "stopping";

  const handleLaunch = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const result = await sendCommand("launchApp", { appId: app.id, workspaceId }, 60_000);
      if (!result.accepted) {
        setError(result.error ?? "Launch failed");
      }
      // apps:launched q:event handles tab auto-open in useAppsLaunched —
      // don't double-open here.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Launch failed");
    } finally {
      setBusy(false);
    }
  }, [app.id, workspaceId]);

  const handleOpen = useCallback(() => {
    if (!running) return;
    workspaceLayoutActions.setActiveContentTab(workspaceId, "browser");
    browserWindowActions.requestNewTab(workspaceId, running.url);
  }, [running, workspaceId]);

  const handleStop = useCallback(async () => {
    if (!running) return;
    setError(null);
    setBusy(true);
    try {
      const result = await sendCommand("stopApp", { runningAppId: running.id });
      if (!result.accepted) {
        setError(result.error ?? "Stop failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Stop failed");
    } finally {
      setBusy(false);
    }
  }, [running]);

  return (
    <div
      data-slot="app-card"
      data-app-id={app.id}
      className={cn(
        "border-border-subtle bg-bg-elevated/60 flex flex-col gap-3 rounded-xl border",
        "p-4 transition-colors duration-150"
      )}
    >
      <div className="flex items-start gap-3">
        <div className="bg-bg-muted flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
          <LayoutGrid className="text-text-tertiary h-4 w-4" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-text-primary truncate text-sm font-medium">{app.name}</h3>
            <span className="text-text-muted shrink-0 text-xs">v{app.version}</span>
          </div>
          <p className="text-text-muted mt-0.5 line-clamp-2 text-xs">{app.description}</p>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2">
        <AppStatusChip status={chipStatus} />

        <div className="flex items-center gap-1">
          {isRunning ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={handleOpen}
              disabled={busy}
              aria-label={`Open ${app.name}`}
            >
              Open
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={handleLaunch}
              disabled={busy || isTransitioning}
              aria-label={chipStatus === "stopping" ? `Stopping ${app.name}` : `Launch ${app.name}`}
            >
              {chipStatus === "starting"
                ? "Starting..."
                : chipStatus === "stopping"
                  ? "Stopping..."
                  : "Launch"}
            </Button>
          )}

          {running && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label={`More actions for ${app.name}`}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-36">
                <DropdownMenuItem
                  onClick={handleStop}
                  disabled={busy || running.status === "stopping"}
                  className="text-xs"
                >
                  <Square className="h-3.5 w-3.5" />
                  <span>Stop</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {error && (
        <p
          className="text-destructive line-clamp-2 text-xs"
          role="alert"
          aria-live="polite"
          title={error}
        >
          {error}
        </p>
      )}
    </div>
  );
}
