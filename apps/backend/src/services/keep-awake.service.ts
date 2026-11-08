// While a paired device is connected, the Mac stays awake if the user allows it
// (Remote access → Keep this Mac awake, on by default). The backend reports when
// that is wanted as a stdout line; the desktop's main process reads it and holds
// a power-save blocker only while the Mac is plugged in (apps/desktop/main/keep-awake.ts).

import { getSetting } from "./settings.service";
import { connectedDeviceIds } from "./ws.service";

export const KEEP_AWAKE_MARKER = "DEUS_KEEP_AWAKE:";

let reported: boolean | null = null;

export function keepAwakeAllowed(): boolean {
  const value = getSetting("remote_keep_awake");
  return value !== false && value !== "false";
}

/** Report a change in whether a connected device should keep the Mac awake. */
export function syncKeepAwake(): void {
  const wanted = keepAwakeAllowed() && connectedDeviceIds().size > 0;
  if (wanted === reported) return;
  reported = wanted;
  process.stdout.write(`${KEEP_AWAKE_MARKER}${wanted ? "1" : "0"}\n`);
}

/** Tests only: forget what was last reported. */
export function resetKeepAwakeForTests(): void {
  reported = null;
}
