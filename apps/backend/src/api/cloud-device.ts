import * as api from "@shared/api/cloud-device";
import {
  execCloudSimulator,
  getCloudSimulatorStatus,
  startCloudSimulator,
  stopCloudSimulator,
} from "../services/agent/cloud/driver";
import { handle } from "./registry";

export default [
  handle(api.cloudSimulator, ({ workspaceId }) => getCloudSimulatorStatus(workspaceId)),
  // Start and stop wait only for the send: an unreachable sandbox refuses the
  // request, and what the device then does arrives as `cloudSimulatorEvents`.
  handle(api.cloudSimStart, ({ workspaceId, platform }) =>
    startCloudSimulator(workspaceId, platform)
  ),
  handle(api.cloudSimStop, ({ workspaceId, platform }) =>
    stopCloudSimulator(workspaceId, platform)
  ),
  // The platform's verdict is the answer, even a failed one: the panel shows its text.
  handle(api.cloudSimExec, ({ workspaceId, ...request }) =>
    execCloudSimulator(workspaceId, request)
  ),
];
