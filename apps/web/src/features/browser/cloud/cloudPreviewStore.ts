/**
 * Cloud preview template — the q:event "cloud:preview" stream.
 *
 * One entry per cloud workspace: the computer's public host template
 * (`https://{{port}}-<sandbox>.e2b.app`), a capability URL template that
 * changes with every reprovision. Nothing is persisted anywhere — the platform
 * replays it on every connect, the backend caches the latest, and a Browser
 * tab that mounts on a workspace nothing was seen for yet reads it once
 * (`cloudPreview`). Absent = never told, `null` = the platform reports no
 * sandbox behind the session.
 */

import { useEffect } from "react";
import { create } from "zustand";
import { CloudPreviewEventSchema } from "@shared/events";
import { onEvent, sendRequest } from "@/platform/ws";

interface CloudPreviewStore {
  byWorkspace: Record<string, string | null>;
  /** Bumped on every cloud:identity. A one-shot read that started under an
   *  earlier generation answers for the previous account and is dropped. */
  generation: number;
}

export const useCloudPreviewStore = create<CloudPreviewStore>()(() => ({
  byWorkspace: {},
  generation: 0,
}));

export const cloudPreviewActions = {
  /** A live announcement (or the one-shot read) — the value REPLACES. */
  set(workspaceId: string, template: string | null): void {
    useCloudPreviewStore.setState((state) =>
      workspaceId in state.byWorkspace && state.byWorkspace[workspaceId] === template
        ? state
        : { byWorkspace: { ...state.byWorkspace, [workspaceId]: template } }
    );
  },
};

// One process-wide listener regardless of how many panels read the store.
let subscribed = false;

export function ensureCloudPreviewSubscription(): void {
  if (subscribed) return;
  subscribed = true;
  onEvent((event, raw) => {
    if (event === "cloud:identity") {
      // The templates were the previous account's sandboxes: forget them all,
      // and disown every read still in flight.
      useCloudPreviewStore.setState((state) => ({
        byWorkspace: {},
        generation: state.generation + 1,
      }));
      return;
    }
    if (event !== "cloud:preview") return;
    const parsed = CloudPreviewEventSchema.safeParse(raw);
    if (!parsed.success) return;
    cloudPreviewActions.set(parsed.data.workspaceId, parsed.data.template);
  });
}

/**
 * The template for a cloud workspace: `undefined` while unknown (the one-shot
 * read is in flight, or the socket has not spoken yet), `null` when the
 * platform reports no sandbox, else the template. Pass null to opt out (a
 * local workspace).
 */
export function useCloudPreviewTemplate(workspaceId: string | null): string | null | undefined {
  const known = useCloudPreviewStore((s) => (workspaceId ? s.byWorkspace[workspaceId] : undefined));
  const unknown = workspaceId !== null && known === undefined;
  useEffect(() => {
    ensureCloudPreviewSubscription();
  }, []);
  // Seed once per unknown workspace; a live event that lands first is newer
  // and wins (the read's answer is dropped once the store knows the value).
  useEffect(() => {
    if (!unknown || !workspaceId) return;
    return seedCloudPreviewTemplate(workspaceId);
  }, [unknown, workspaceId]);
  return workspaceId ? known : undefined;
}

/**
 * The one-shot read for a workspace the store knows nothing about. Returns
 * the cancel for the effect that started it. `undefined` from the backend =
 * it has not been told either and is opening the session whose snapshot will
 * announce the template: keep waiting for the event. An answer that started
 * under an earlier identity generation is the previous account's capability
 * URL and is dropped.
 */
export function seedCloudPreviewTemplate(workspaceId: string): () => void {
  let cancelled = false;
  const generation = useCloudPreviewStore.getState().generation;
  sendRequest<string | null | undefined>("cloudPreview", { workspaceId })
    .then((template) => {
      if (cancelled || template === undefined) return;
      const state = useCloudPreviewStore.getState();
      if (state.generation !== generation) return;
      if (state.byWorkspace[workspaceId] === undefined) {
        cloudPreviewActions.set(workspaceId, template);
      }
    })
    .catch(() => {
      // Unreachable backend: stay unknown; the socket's own frame will tell.
    });
  return () => {
    cancelled = true;
  };
}
