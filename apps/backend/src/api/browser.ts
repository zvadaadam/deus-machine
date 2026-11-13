/** Answers the operations in `shared/api/browser.ts`. */

import * as api from "@shared/api/browser";
import { getDiscoveredServers } from "../services/local-servers.service";
import { handle } from "./registry";

export default [
  // Answers from the last sweep and starts a new one when that is stale; the
  // server invalidates `localServers` when each sweep ends.
  handle(api.localServers, () => getDiscoveredServers()),
];
