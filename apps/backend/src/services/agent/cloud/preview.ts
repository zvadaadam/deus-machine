// apps/backend/src/services/agent/cloud/preview.ts
// The cloud computer's public host template (`https://{{port}}-<sandbox>.e2b.app`)
// — what the Browser tab substitutes a port into. Same posture as
// ./simulator: an in-memory cache, never a row. The template is a capability
// URL (the sandbox id is its only secret) that changes with every reprovision
// and is replayed by the platform on every connect (the running frame, the
// snapshot), so a copy on the workspace row would only be a stale,
// account-scoped second truth. driver.ts feeds this from the frames; clients
// read it once (the `cloudPreview` request) and follow `cloud:preview`.

import type { CloudPreviewEvent } from "@shared/events";
import { broadcast } from "../../ws.service";

/** The session a frame arrived on — the two ids the event envelope needs. */
export interface CloudPreviewSource {
  workspaceId: string;
  sessionId: string;
}

/** workspaceId → template; a null entry means the platform said "no sandbox
 *  behind the session" (known-none), an absent entry means never told. */
const previewTemplates = new Map<string, string | null>();

/** Forget every template: identity change (they were account A's computers)
 *  and driver shutdown. */
export function forgetCloudPreviewTemplates(): void {
  previewTemplates.clear();
}

/** A running frame or snapshot carried the template (or `null`: no sandbox
 *  behind the session). Remember it and tell the clients — unchanged values
 *  are not re-announced (reconnect snapshots repeat them). */
export function applyCloudPreviewTemplate(
  source: CloudPreviewSource,
  template: string | null
): void {
  const value = template || null;
  const known = previewTemplates.has(source.workspaceId);
  if (known && previewTemplates.get(source.workspaceId) === value) return;
  previewTemplates.set(source.workspaceId, value);
  const event: CloudPreviewEvent = {
    workspaceId: source.workspaceId,
    sessionId: source.sessionId,
    template: value,
  };
  broadcast(JSON.stringify({ type: "q:event", event: "cloud:preview", data: event }));
}

/** What the cache knows: the template, `null` for a platform-reported "no
 *  sandbox", `undefined` when never told. The driver's readCloudPreviewTemplate
 *  answers the `cloudPreview` request with this and, for `undefined`, opens
 *  the session whose snapshot is the template's only source. */
export function getCloudPreviewTemplate(workspaceId: string): string | null | undefined {
  return previewTemplates.get(workspaceId);
}
