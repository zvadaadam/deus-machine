/** Answers the operations in `shared/api/devices.ts`. */

import * as api from "@shared/api/devices";
import { NotFoundError } from "../lib/errors";
import { getRelayStatus } from "../services/relay.service";
import { listDevices, revokeDevice } from "../services/remote-auth.service";
import { handle } from "./registry";

// Pairing itself stays plain HTTP (routes/remote-auth.ts): a device that is not
// paired yet has no connection to ask on, and asking for a code is localhost-only.
export default [
  handle(api.pairedDevices, () => ({ devices: listDevices() })),
  handle(api.relayStatus, () => getRelayStatus()),
  handle(api.revokeDevice, ({ deviceId }) => {
    if (!revokeDevice(deviceId)) throw new NotFoundError("Device not found");
  }),
];
