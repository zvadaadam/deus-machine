/** Remote access: the devices paired with this computer and the state of its tunnel. */

import { z } from "zod";
import type { PairedDevice, RelayStatus } from "../types/devices";
import { live, out, read, write } from "./op";

/** The devices this computer approved, and which of them are connected right now. */
export const pairedDevices = live({
  name: "pairedDevices",
  output: out<{ devices: PairedDevice[] }>(),
});

/** Whether other devices can reach this computer through its Deus account, and why not. */
export const relayStatus = read({ name: "relayStatus", output: out<RelayStatus>() });

/** Take a device's access away. Its open connections are closed. */
export const revokeDevice = write({
  name: "revokeDevice",
  input: z.object({ deviceId: z.string().min(1) }),
  output: out<void>(),
});
