/** Answers the operations in `shared/api/browser.ts`. */

import * as api from "@shared/api/browser";
import { readCloudPreviewTemplate } from "../services/agent/cloud/driver";
import { getDiscoveredServers } from "../services/local-servers.service";
import { handle } from "./registry";

export default [
  // Answers from the last sweep and starts a new one when that is stale; the
  // server invalidates `local_servers` when each sweep ends.
  handle(api.localServers, () => getDiscoveredServers()),
  handle(api.cloudPreview, ({ workspaceId }) => readCloudPreviewTemplate(workspaceId)),
];
