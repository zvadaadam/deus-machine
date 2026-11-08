// Keeps the Mac awake while a paired device is connected and the Mac is
// plugged in (Remote access → Keep this Mac awake). The backend says when a
// connected device wants it (`DEUS_KEEP_AWAKE:1|0` on its stdout, see
// apps/backend/src/services/keep-awake.service.ts); this module adds the power
// source. "prevent-app-suspension" stops idle sleep and still lets the display sleep.

import { powerMonitor, powerSaveBlocker } from "electron";

const MARKER = "DEUS_KEEP_AWAKE:";

let wanted = false;
let blockerId: number | null = null;
let watching = false;

function apply(): void {
  const block = wanted && !powerMonitor.isOnBatteryPower();
  if (block && blockerId === null) {
    blockerId = powerSaveBlocker.start("prevent-app-suspension");
  } else if (!block && blockerId !== null) {
    if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
    blockerId = null;
  }
}

/** Reads one backend stdout line; returns true when it was a keep-awake marker. */
export function handleKeepAwakeLine(line: string): boolean {
  if (!line.startsWith(MARKER)) return false;
  setKeepAwakeWanted(line.slice(MARKER.length) === "1");
  return true;
}

export function setKeepAwakeWanted(next: boolean): void {
  wanted = next;
  if (wanted && !watching) {
    // powerMonitor is only usable after app ready, which precedes any backend output.
    watching = true;
    powerMonitor.on("on-ac", apply);
    powerMonitor.on("on-battery", apply);
  }
  apply();
}
