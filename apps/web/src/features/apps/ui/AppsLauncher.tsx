/**
 * Apps content tab — grid of installed agentic apps with per-card
 * launch/stop controls and live status chips.
 *
 * Reads two reactive resources:
 *   apps         (global registry)     → useInstalledApps
 *   running_apps (workspace-scoped)    → useRunningApps(workspaceId)
 *
 * Both stream via q:subscribe; the service emits invalidate(["apps",
 * "running_apps"]) on every state transition so chips update in real time.
 */

import { useMemo, type ReactNode } from "react";
import { useInstalledApps } from "../hooks/useInstalledApps";
import { useRunningApps } from "../hooks/useRunningApps";
import { AppCard } from "./AppCard";
import type { RunningApp } from "@shared/aap/types";

interface AppsLauncherProps {
  workspaceId: string | null;
  toolbarAction?: ReactNode;
}

export function AppsLauncher({ workspaceId, toolbarAction }: AppsLauncherProps) {
  const { data: apps, isLoading: appsLoading } = useInstalledApps();
  const { data: running } = useRunningApps(workspaceId);

  // Map appId → RunningApp for O(1) card lookup. Two apps with the same
  // appId can't be running in the same workspace (apps.service dedupes on
  // (appId, workspaceId)) so the last-writer collision is impossible here.
  const runningByAppId = useMemo(() => {
    const m = new Map<string, RunningApp>();
    for (const r of running) m.set(r.appId, r);
    return m;
  }, [running]);

  return (
    <div className="flex h-full min-w-0 flex-col">
      {toolbarAction && (
        <div className="border-border-subtle flex h-10 shrink-0 items-center justify-between border-b px-3">
          <span className="text-text-secondary text-sm">Installed apps</span>
          {toolbarAction}
        </div>
      )}
      {appsLoading && !apps ? (
        <div className="text-text-muted flex flex-1 items-center justify-center p-4 text-sm">
          Loading apps…
        </div>
      ) : !apps || apps.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 p-6">
          <p className="text-text-secondary text-sm">No apps installed</p>
          <p className="text-text-muted text-xs">
            CLI-based install is coming soon. For now, apps ship with Deus.
          </p>
        </div>
      ) : !workspaceId ? (
        <div className="text-text-muted flex flex-1 items-center justify-center p-4 text-sm">
          Select a workspace to launch apps.
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {apps.map((app) => (
              <AppCard
                key={app.id}
                app={app}
                running={runningByAppId.get(app.id) ?? null}
                workspaceId={workspaceId}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
