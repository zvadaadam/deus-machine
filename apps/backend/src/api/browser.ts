/** Answers the operations in `shared/api/browser.ts`. */

import * as api from "@shared/api/browser";
import { AppError } from "../lib/errors";
import { readCloudPreviewTemplate } from "../services/agent/cloud/driver";
import { listBrowserProfiles, readProfileCookies } from "../services/browser-import.service";
import { getDiscoveredServers } from "../services/local-servers.service";
import { handle } from "./registry";

export default [
  // Answers from the last sweep and starts a new one when that is stale; the
  // server invalidates `localServers` when each sweep ends.
  handle(api.localServers, () => getDiscoveredServers()),
  handle(api.cloudPreview, ({ workspaceId }) => readCloudPreviewTemplate(workspaceId)),
  handle(api.browserProfiles, () => listBrowserProfiles()),
  // Decrypted sign-ins: never for a paired device (assistants the registry refuses).
  handle(api.browserCookies, ({ browserId, profileDir }, { caller }) => {
    if (caller.deviceId) throw new AppError(403, "Browser import works only on this computer.");
    return readProfileCookies(browserId, profileDir);
  }),
];
