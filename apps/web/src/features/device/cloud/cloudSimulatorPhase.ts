/**
 * What the panel shows, after folding the optimistic `busy` marker into the
 * platform's status. Pure, so the header, the frame body and the tests share
 * one reading of the device.
 */

import { match, P } from "ts-pattern";
import type { CloudSimDevice } from "./cloudSimulatorStore";

export type CloudSimPhase = "idle" | "booting" | "live" | "stopping" | "error";

export function cloudSimPhase(device: CloudSimDevice): CloudSimPhase {
  if (device.busy === "starting") return "booting";
  if (device.busy === "stopping") return "stopping";
  return (
    match(device.status)
      .with(P.nullish, "stopped", () => "idle" as const)
      // A ready device without a stream URL is still "booting" to the viewer:
      // there is nothing to embed until the platform hands over the URL.
      .with("starting", "ready", () =>
        device.streamUrl ? ("live" as const) : ("booting" as const)
      )
      .with("stopping", () => "stopping" as const)
      .with("error", () => "error" as const)
      // The status set is open (CloudSimulatorStatusSchema): a status this build
      // doesn't know is in-flight, never "off" — offering Start against a device
      // the platform still owns would be the misleading choice.
      .otherwise(() => "booting" as const)
  );
}

export function cloudDeviceLabel(platform: CloudSimDevice["platform"]): string {
  return match(platform)
    .with("ios", () => "iPhone (cloud)")
    .with("android", () => "Android (cloud)")
    .with(null, () => "Cloud device")
    .exhaustive();
}
