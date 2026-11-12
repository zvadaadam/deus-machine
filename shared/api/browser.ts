/** Browser: local dev servers found on this computer and a cloud workspace's preview address. */

import { z } from "zod";
import type { LocalServersSnapshot } from "../types/local-server";
import { live, out, read } from "./op";

/** The dev servers answering on this computer's common ports, for the Browser tab's empty state. */
export const localServers = live({ name: "local_servers", output: out<LocalServersSnapshot>() });

/**
 * The address template of a cloud workspace's sandbox (`https://{{port}}-<sandbox>.e2b.app`).
 * `null` when the platform reports no sandbox; `undefined` when the backend has
 * not been told yet, in which case the template follows as a `cloud:preview` event.
 */
export const cloudPreview = read({
  name: "cloudPreview",
  input: z.object({ workspaceId: z.string().min(1) }),
  output: out<string | null | undefined>(),
});
