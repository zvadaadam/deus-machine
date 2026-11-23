import { useEffect, useState } from "react";
import { createStore, useStore } from "zustand";
import { toast } from "sonner";
import { api } from "@shared/api";
import { WORKSPACE_LINK_AVAILABLE } from "@shared/events";
import type { WorkspaceLink } from "@shared/workspace-link";
import { native } from "@/platform";
import { call } from "@/platform/ws";
import { openChat } from "@/features/session/lib/openChat";
import { useWorkspacesByRepo } from "../api";
import { openWorkspace } from "../lib/openWorkspace";
import { findOpenWorkspace, resolveWorkspaceLink } from "../lib/resolveWorkspaceLink";

export function useOpenWorkspaceLink(ready: boolean): void {
  // A newer IPC reply must supersede a pending chat lookup before React runs its cleanup.
  const [pending] = useState(() => createStore<WorkspaceLink | null>(() => null));
  const link = useStore(pending);
  const { data: groups } = useWorkspacesByRepo();

  useEffect(() => {
    if (!ready) return;
    const take = () => {
      void native.window.takeWorkspaceLink().then((next) => {
        if (next) pending.setState(next, true);
      });
    };
    const stop = native.events.on(WORKSPACE_LINK_AVAILABLE, take);
    take();
    return stop;
  }, [pending, ready]);

  useEffect(() => {
    if (!link || !groups || !ready) return;
    let current = true;
    function takeCurrent(): boolean {
      if (!current || pending.getState() !== link) return false;
      pending.setState(null, true);
      return true;
    }
    const chats =
      link.sessionId && findOpenWorkspace(groups, link.workspaceId)
        ? call(api.sessions, { workspaceId: link.workspaceId })
        : Promise.resolve([]);
    void chats.then(
      (sessions) => {
        if (!takeCurrent()) return;
        const { workspace, sessionId, message } = resolveWorkspaceLink(link, groups, sessions);
        if (workspace) {
          if (sessionId) openChat(workspace.id, sessionId);
          else openWorkspace(workspace);
        }
        if (message) toast(message);
      },
      () => {
        if (!takeCurrent()) return;
        toast.error("Couldn't open the workspace link.");
      }
    );
    return () => {
      current = false;
    };
  }, [groups, link, pending, ready]);
}
