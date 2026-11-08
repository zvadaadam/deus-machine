// While a paired device is connected, the Mac stays awake if the user allows it
// (Remote access → Keep this Mac awake, on by default). The backend reports when
// that is wanted as a stdout line (shared/keep-awake.ts); the desktop's main
// process reads it and holds a power-save blocker only while the Mac is plugged
// in (apps/desktop/main/keep-awake.ts).

import { keepAwakeLine } from "@shared/keep-awake";
import { getSetting } from "./settings.service";
import { connectedDeviceIds } from "./ws.service";

/** How long the Mac stays awake after its last device drops: a relay tunnel
 *  redials within 30s, and a phone switching networks comes back as quickly.
 *  Asleep, the Mac could not take either back. */
export const KEEP_AWAKE_GRACE_MS = 2 * 60_000;

let reported: boolean | null = null;
let release: ReturnType<typeof setTimeout> | null = null;

export function keepAwakeAllowed(): boolean {
  const value = getSetting("remote_keep_awake");
  return value !== false && value !== "false";
}

function report(wanted: boolean): void {
  if (wanted === reported) return;
  reported = wanted;
  process.stdout.write(`${keepAwakeLine(wanted)}\n`);
}

function cancelRelease(): void {
  if (release) clearTimeout(release);
  release = null;
}

/** Report a change in whether a connected device should keep the Mac awake. */
export function syncKeepAwake(): void {
  const devices = connectedDeviceIds().size > 0;
  // Nothing held and nothing connected: settled without reading the settings.
  if (!devices && reported !== true) return report(false);
  if (!keepAwakeAllowed() || getSetting("remote_access_enabled") !== true) {
    cancelRelease();
    return report(false);
  }
  if (devices) {
    cancelRelease();
    return report(true);
  }
  release ??= setTimeout(() => {
    release = null;
    if (connectedDeviceIds().size === 0) report(false);
  }, KEEP_AWAKE_GRACE_MS);
  release.unref?.();
}

/** Tests only: forget what was last reported. */
export function resetKeepAwakeForTests(): void {
  cancelRelease();
  reported = null;
}
