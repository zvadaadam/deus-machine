import { useEffect, useLayoutEffect, useRef } from "react";
import { useParams, useRouter } from "@tanstack/react-router";
import { ErrorBoundary } from "react-error-boundary";
import { workspaceAddress, workspaceChatId } from "@/features/workspace/lib/workspaceAddress";
import { useWorkspaceStore } from "@/features/workspace/store";
import { DashboardError } from "@/shared/components";
import { uiActions, useUIStore } from "@/shared/stores/uiStore";
import { createBoundaryErrorHandler } from "@/shared/utils/errorReporting";
import { MainLayout } from "../layouts/MainLayout";
import { writeWorkspaceSelection } from "./workspaceNavigation";

export function SettingsRoute() {
  const { serverId } = useParams({ strict: false });
  const router = useRouter();
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const wasOpen = useRef(false);

  useLayoutEffect(() => {
    uiActions.openSettings();
    return uiActions.closeSettings;
  }, []);

  // showWorkspace closes Settings and selects the workspace in the same action.
  // Read the selection after the close commits so the address includes its destination.
  useEffect(() => {
    if (wasOpen.current && !settingsOpen) {
      const id = useWorkspaceStore.getState().selectedWorkspaceId;
      writeWorkspaceSelection(router, workspaceAddress(serverId, id, workspaceChatId(id)), true);
    }
    wasOpen.current = settingsOpen;
  }, [router, serverId, settingsOpen]);

  return (
    <ErrorBoundary
      FallbackComponent={DashboardError}
      onError={createBoundaryErrorHandler("react.error-boundary.settings")}
    >
      <MainLayout />
    </ErrorBoundary>
  );
}
