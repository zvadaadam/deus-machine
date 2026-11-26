import * as api from "@shared/api/device-hub";
import { AppError } from "../lib/errors";
import { listHubDevices, startHubDevice } from "../services/device-hub/devices";
import { deviceHub, deviceSupport } from "../services/device-hub";
import { onFollow, openWith } from "../services/streams";
import { getConnection } from "../services/ws.service";
import { handle } from "./registry";

function requireLocal(relayed: boolean, deviceId: string | null) {
  if (relayed || deviceId) throw new AppError(403, "Devices are available on this computer only.");
}

onFollow(api.deviceHubStatus, (scope, connectionId) => {
  const connection = getConnection(connectionId);
  requireLocal(!connection || connection.isVirtual === true, connection?.deviceId ?? null);
  return deviceHub.follow(scope);
});
openWith(api.deviceHubStatus, () => [deviceHub.status]);

export default [
  handle(api.deviceSupport, (_, { caller }) => deviceSupport(caller.relayed || !!caller.deviceId)),
  handle(api.deviceSetup, (_, { caller }) => {
    requireLocal(caller.relayed, caller.deviceId);
    return deviceHub.setupState();
  }),
  handle(api.deviceHubDevices, (_, { caller }) => {
    requireLocal(caller.relayed, caller.deviceId);
    return listHubDevices(deviceHub.endpoint);
  }),
  handle(api.startHubDevice, (input, { caller }) => {
    requireLocal(caller.relayed, caller.deviceId);
    return startHubDevice(deviceHub.endpoint, input, input.boot);
  }),
  handle(api.retryDeviceHub, (_, { caller }) => {
    requireLocal(caller.relayed, caller.deviceId);
    deviceHub.retry();
  }),
];
