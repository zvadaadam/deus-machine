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

import { useEffect, useRef } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { ErrorBoundary } from "react-error-boundary";
import { DashboardError } from "@/shared/components";
import { createBoundaryErrorHandler } from "@/shared/utils/errorReporting";
import { MainLayout } from "../layouts/MainLayout";
import { useWorkspaceStore } from "@/features/workspace/store";
import { isCloudDirectWebMode } from "@/shared/config/webDirectMode";

export function WorkspaceRoute() {
  // Extract $workspaceId -- may be undefined on the server index route
  const params = useParams({ strict: false }) as { workspaceId?: string };
  const selectWorkspace = useWorkspaceStore((s) => s.selectWorkspace);

  // Web-direct only: mirror the store back into the URL, so a reload or the
  // back button keeps the selection (the product lives at /w/:id there).
  // Desktop/relay stay store-only. A store subscription rather than an effect
  // on the rendered value — the param→store sync below sets the store on
  // mount, and an effect would see the pre-sync null next to a real param and
  // bounce to "/". The ref carries the current param into the listener; its
  // effect is declared FIRST so it has run by the time the sync fires it.
  const navigate = useNavigate();
  const paramWorkspaceIdRef = useRef<string | null>(null);
  useEffect(() => {
    paramWorkspaceIdRef.current = params.workspaceId ?? null;
  }, [params.workspaceId]);

  // Sync route param -> workspace store. When navigating to
  // /s/{id}/w/{workspaceId}, the store updates and MainLayout picks it up.
  // When on /s/{id}/ (no workspace), we clear the selection.
  useEffect(() => {
    selectWorkspace(params.workspaceId ?? null);
  }, [params.workspaceId, selectWorkspace]);

  useEffect(() => {
    if (!isCloudDirectWebMode()) return;
    return useWorkspaceStore.subscribe((state, prev) => {
      const next = state.selectedWorkspaceId;
      if (next === prev.selectedWorkspaceId || next === paramWorkspaceIdRef.current) return;
      if (next) {
        void navigate({ to: "/w/$workspaceId", params: { workspaceId: next } });
      } else {
        void navigate({ to: "/" });
      }
    });
  }, [navigate]);

  return (
    <ErrorBoundary
      FallbackComponent={DashboardError}
      onError={createBoundaryErrorHandler("react.error-boundary.workspace")}
    >
      <MainLayout />
    </ErrorBoundary>
  );
}
