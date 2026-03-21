/**
 * WorkspaceRoute -- thin route wrapper for workspace views.
 *
 * Extracts $workspaceId from route params (if present) and syncs it
 * to the workspace Zustand store. Then renders MainLayout, which reads
 * from the store as before. This keeps MainLayout router-agnostic.
 *
 * Used for both:
 * - /s/$serverId/ (no workspace selected, index route)
 * - /s/$serverId/w/$workspaceId (specific workspace)
 */

import { useEffect } from "react";
import { useParams } from "@tanstack/react-router";
import { ErrorBoundary } from "react-error-boundary";
import { DashboardError } from "@/shared/components";
import { createBoundaryErrorHandler } from "@/shared/utils/errorReporting";
import { MainLayout } from "../layouts/MainLayout";
import { useWorkspaceStore } from "@/features/workspace/store";

export function WorkspaceRoute() {
  // Extract $workspaceId -- may be undefined on the server index route
  const params = useParams({ strict: false }) as { workspaceId?: string };
  const selectWorkspace = useWorkspaceStore((s) => s.selectWorkspace);

  // Sync route param -> workspace store. When navigating to
  // /s/{id}/w/{workspaceId}, the store updates and MainLayout picks it up.
  // When on /s/{id}/ (no workspace), we clear the selection.
  useEffect(() => {
    selectWorkspace(params.workspaceId ?? null);
  }, [params.workspaceId, selectWorkspace]);

  return (
    <ErrorBoundary
      FallbackComponent={DashboardError}
      onError={createBoundaryErrorHandler("react.error-boundary.workspace")}
    >
      <MainLayout />
    </ErrorBoundary>
  );
}
