import { z } from "zod";
import type { HubDevice, HubInventory, HubStatus } from "../types/device-hub";
import { out, read, write } from "./op";
import { stream, type ScopeOf } from "./stream";

export const deviceHubStatus = stream({
  name: "deviceHubStatus",
  scope: z.object({
    workspaceId: z.string().min(1),
    platform: z.enum(["ios", "android"]).nullable(),
    deviceId: z.string().min(1).max(256).nullable(),
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
  input: z.object({ platform: z.enum(["ios", "android"]), id: z.string().min(1) }),
  output: out<HubDevice>(),
});
