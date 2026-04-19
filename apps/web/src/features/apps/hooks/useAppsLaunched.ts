/**
 * Listen for `apps:launched` q:event broadcasts and auto-open the app's URL in
 * a new Browser tab for the current workspace.
 *
 * The backend emits this event on every successful launch — user-initiated
 * (launchApp q:command) and agent-initiated (mcp__deus__launch_app tool call)
 * flow through the same service method, so this single listener covers both.
 *
 * Workspace filtering: a launch for a different workspace doesn't poke the
 * current workspace's browser. The content-tab switch to "browser" is also
 * workspace-scoped — the auto-switch would be wrong if we're looking at
 * workspace A while workspace B spawns an app in the background.
 *
 * Always mount this hook during a workspace session (not gated on active tab)
 * so a launch that completes while the user is on Changes still pops the
 * Browser tab to the foreground.
 */

import { useEffect } from "react";
import { onEvent } from "@/platform/ws/query-protocol-client";
import type { AppsLaunchedEvent } from "@shared/aap/types";
import { browserWindowActions } from "@/features/browser/store/browserWindowStore";
import { workspaceLayoutActions } from "@/features/workspace/store/workspaceLayoutStore";

export function useAppsLaunched(currentWorkspaceId: string | null): void {
  useEffect(() => {
    if (!currentWorkspaceId) return;

    const unsubscribe = onEvent((event, data) => {
      if (event !== "apps:launched") return;

      // Narrow the unknown payload. Only proceed if it matches our contract
      // AND targets the current workspace — other workspaces' launches are
      // ignored (their own useAppsLaunched mount will handle them).
      const payload = data as AppsLaunchedEvent | null | undefined;
      if (!payload || typeof payload !== "object") return;
      if (payload.workspaceId !== currentWorkspaceId) return;
      if (typeof payload.url !== "string" || payload.url.length === 0) return;

      // Switch the content tab to "browser" so the new tab is visible, then
      // request the Browser panel open a tab pointing at the app URL.
      workspaceLayoutActions.setActiveContentTab(currentWorkspaceId, "browser");
      browserWindowActions.requestNewTab(currentWorkspaceId, payload.url);
    });

    return unsubscribe;
  }, [currentWorkspaceId]);
}
