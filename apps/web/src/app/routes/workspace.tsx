import { useEffect, useLayoutEffect } from "react";
import { useParams, useRouteContext, useRouter, useSearch } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ErrorBoundary } from "react-error-boundary";
import { toast } from "sonner";
import { useWorkspaceSessions } from "@/features/session/api/session.queries";
import { currentOpenChatRequest, openChat } from "@/features/session/lib/openChat";
import {
  SIDEBAR_WORKSPACE_STATE,
  useWorkspacesByRepo,
} from "@/features/workspace/api/workspace.queries";
import { showWorkspace } from "@/features/workspace/lib/openWorkspace";
import {
  findOpenWorkspace,
  resolveWorkspaceLink,
  NO_OPEN_WORKSPACE,
} from "@/features/workspace/lib/resolveWorkspaceLink";
import {
  homeForMissingWorkspace,
  workspaceAddress,
  workspaceChatId,
} from "@/features/workspace/lib/workspaceAddress";
import { useWorkspaceLayoutStore, useWorkspaceStore } from "@/features/workspace/store";
import type { RepoGroup } from "@/features/workspace/types";
import { queryKeys } from "@/shared/api/queryKeys";
import { DashboardError } from "@/shared/components";
import { createBoundaryErrorHandler } from "@/shared/utils/errorReporting";
import { MainLayout } from "../layouts/MainLayout";
import { isWorkspaceSelectionWrite, writeWorkspaceSelection } from "./workspaceNavigation";

export function WorkspaceRoute() {
  const { serverId, workspaceId } = useParams({ strict: false });
  const { session } = useSearch({ strict: false });
  const router = useRouter();
  const visit = useRouteContext({ strict: false, select: (context) => context.visit });
  const incomingVisit = visit && !isWorkspaceSelectionWrite(visit) ? visit : undefined;
  const { data: groups, refetch } = useWorkspacesByRepo();
  const cache = useQueryClient();
  const workspace = workspaceId && groups ? findOpenWorkspace(groups, workspaceId) : undefined;
  const missing = !!workspaceId && !!groups && !workspace;

  // Apply an incoming address before listening for selections. On Back or a fresh
  // link the store still holds the page we are leaving (Home on a fresh mount).
  useLayoutEffect(() => {
    if (incomingVisit) {
      if (workspaceId) showWorkspace(workspaceId);
      else useWorkspaceStore.getState().selectWorkspace(null);
    }
    return useWorkspaceStore.subscribe(({ selectedWorkspaceId: next }, prev) => {
      if (next === prev.selectedWorkspaceId) return;
      writeWorkspaceSelection(router, workspaceAddress(serverId, next, workspaceChatId(next)));
    });
  }, [incomingVisit, serverId, workspaceId, router]);

  // The sidebar can hide an archive before its write succeeds, and a new workspace
  // can be selected before its first push. Confirm a miss against the host's list.
  useEffect(() => {
    if (!workspaceId || !missing) return;
    const home = homeForMissingWorkspace(serverId);
    if (!home) return;
    let current = true;
    void refetch().then(({ isSuccess }) => {
      if (
        !current ||
        !isSuccess ||
        useWorkspaceStore.getState().selectedWorkspaceId !== workspaceId
      )
        return;
      const rows = cache.getQueryData<RepoGroup[]>(
        queryKeys.workspaces.byRepo(SIDEBAR_WORKSPACE_STATE)
      );
      if (!rows || findOpenWorkspace(rows, workspaceId)) return;
      toast(NO_OPEN_WORKSPACE);
      void router.navigate({ href: home, replace: true });
    });
    return () => {
      current = false;
    };
  }, [missing, workspaceId, serverId, refetch, cache, router]);

  const incomingSession = incomingVisit ? session : undefined;
  const { data: chats } = useWorkspaceSessions(incomingSession && workspace ? workspace.id : null);
  const resolved =
    workspace && incomingSession && groups && chats
      ? resolveWorkspaceLink(
          { workspaceId: workspace.id, sessionId: incomingSession },
          groups,
          chats
        )
      : undefined;
  const ready = !!workspace && (!incomingSession || !!resolved);
  const linkedSession = resolved?.sessionId;
  const message = resolved?.message;
  useLayoutEffect(() => {
    if (!workspaceId || !ready) return;
    if (message) toast(message, { id: `missing-chat-${session}` });
    if (linkedSession && currentOpenChatRequest(workspaceId)?.sessionId !== linkedSession) {
      openChat(workspaceId, linkedSession);
    }

    const followChat = () => {
      if (useWorkspaceStore.getState().selectedWorkspaceId !== workspaceId) return;
      const active = workspaceChatId(workspaceId);
      if (active !== undefined && active !== (session ?? null)) {
        writeWorkspaceSelection(router, workspaceAddress(serverId, workspaceId, active), true);
      }
    };
    followChat();
    return useWorkspaceLayoutStore.subscribe((state, prev) => {
      if (state.layouts[workspaceId] !== prev.layouts[workspaceId]) followChat();
    });
  }, [incomingVisit, serverId, workspaceId, session, ready, linkedSession, message, router]);

  return (
    <ErrorBoundary
      FallbackComponent={DashboardError}
      onError={createBoundaryErrorHandler("react.error-boundary.workspace")}
    >
      <MainLayout />
    </ErrorBoundary>
  );
}
