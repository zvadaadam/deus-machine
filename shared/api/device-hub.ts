import { z } from "zod";
import type { DeviceSupport, HubDevice, HubInventory, HubStatus } from "../types/device-hub";
import { out, read, write } from "./op";
import { stream, type ScopeOf } from "./stream";

export const deviceSupport = read({ name: "deviceSupport", output: out<DeviceSupport>() });

export const deviceHubStatus = stream({
  name: "deviceHubStatus",
  scope: z.object({
    workspaceId: z.string().min(1),
    platform: z.enum(["ios", "android"]).nullable(),
    deviceId: z.string().min(1).max(256).nullable(),
    displayedInstance: z.string().nullable(),
  }),
  event: out<HubStatus>(),
});
export type HubView = ScopeOf<typeof deviceHubStatus>;
export const retryDeviceHub = write({ name: "retryDeviceHub", output: out<void>() });

export const deviceHubDevices = read({
  name: "deviceHubDevices",
  output: out<HubInventory>(),
});

export const startHubDevice = write({
  name: "startHubDevice",
  input: z.object({
    platform: z.enum(["ios", "android"]),
    identity: z.string().min(1),
    boot: z.boolean(),
  }),
  output: out<HubDevice>(),
});
