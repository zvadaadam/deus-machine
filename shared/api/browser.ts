/** Browser: local dev servers found on this computer and a cloud workspace's preview address. */

import { z } from "zod";
import type { BrowserId, BrowserProfile, ImportCookie } from "../types/browser-import";
import type { LocalServersSnapshot } from "../types/local-server";
import { live, out, read } from "./op";
import { stream } from "./stream";
import type { CloudPreviewEvent } from "../events";

/** The dev servers answering on this computer's common ports, for the Browser tab's empty state. */
export const localServers = live({ name: "localServers", output: out<LocalServersSnapshot>() });

/**
 * The address template of a cloud workspace's sandbox (`https://{{port}}-<sandbox>.e2b.app`).
 * `null` when the platform reports no sandbox; `undefined` when the backend has
 * not been told yet, in which case the template follows as a `cloudPreviewChanges` event.
 */
export const cloudPreview = read({
  name: "cloudPreview",
  input: z.object({ workspaceId: z.string().min(1) }),
  output: out<string | null | undefined>(),
});

/** A cloud workspace's preview address changed (it changes each time its sandbox is rebuilt). */
export const cloudPreviewChanges = stream({
  name: "cloudPreviewChanges",
  scope: z.object({ workspaceId: z.string() }),
  event: out<CloudPreviewEvent>(),
});

/** The Chromium browser profiles on this computer whose sign-ins the Browser tab can import. */
export const browserProfiles = read({ name: "browserProfiles", output: out<BrowserProfile[]>() });

/**
 * One profile's cookies, decrypted, for the desktop to put into the Browser tab.
 * The first read per browser waits on the macOS Keychain prompt. This computer's window only.
 */
export const browserCookies = read({
  name: "browserCookies",
  input: z.object({
    browserId: z.enum(["chrome", "brave", "edge", "arc"] as const satisfies readonly BrowserId[]),
    profileDir: z.string().min(1),
  }),
  output: out<ImportCookie[]>(),
});
