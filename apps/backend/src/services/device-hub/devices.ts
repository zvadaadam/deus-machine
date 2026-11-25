import { z } from "zod";
import { getErrorMessage } from "@shared/lib/errors";
import type { HubDevice, HubInventory } from "@shared/types/device-hub";
import { AppError, ConflictError } from "../../lib/errors";
import { hasSimulatorToolchain, listDevices, simctl } from "../simulator-context";
import { hasAndroidToolchain } from "./android-sdk";
import type { HubEndpoint } from "./manager";

const device = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  platform: z.enum(["ios", "android"]),
  booted: z.boolean(),
});
const errors = z.array(z.object({ message: z.string(), error: z.string().nullish() }));
const inventory = z.object({ simulators: z.array(device), emulators: z.array(device), errors });
const action = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  errors: errors.optional(),
  serial: z.string().optional(),
});

function toolDetail(issues: z.infer<typeof errors>) {
  return issues
    .flatMap((issue) => [issue.message, issue.error])
    .filter(Boolean)
    .join("\n");
}

async function request(hub: HubEndpoint | null, path: string, body?: object) {
  if (!hub) throw new ConflictError("Devices are not running.");
  try {
    const res = await fetch(hub.origin + path, {
      method: body ? "POST" : "GET",
      redirect: "error",
      headers: { authorization: `Bearer ${hub.token}`, "content-type": "application/json" },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(body ? 190_000 : 20_000),
    });
    const text = await res.text();
    if (text.includes(hub.token)) throw new Error();
    const value: unknown = JSON.parse(text);
    if (!res.ok && !action.safeParse(value).success) throw new Error();
    return value;
  } catch {
    throw new AppError(502, "The device service did not answer.");
  }
}

async function iosDevices(): Promise<HubDevice[]> {
  const all = await listDevices();
  return all
    .filter((sim) => sim.runtime.startsWith("iOS "))
    .map((sim) => ({
      platform: "ios",
      id: sim.udid,
      name: sim.name,
      version: sim.runtime,
      booted: sim.state === "Booted",
    }));
}

async function listSimulators() {
  const available = await hasSimulatorToolchain();
  if (available) {
    try {
      return { available, devices: await iosDevices(), detail: null };
    } catch (error) {
      return { available, devices: [], detail: getErrorMessage(error) };
    }
  }
  return { available, devices: [], detail: null };
}

async function hubInventory(hub: HubEndpoint | null) {
  return inventory.parse(await request(hub, "/api/devices"));
}

export async function listHubDevices(hub: HubEndpoint | null): Promise<HubInventory> {
  const [list, ios, android] = await Promise.all([
    hubInventory(hub),
    listSimulators(),
    hasAndroidToolchain(),
  ]);
  const known = new Set(list.simulators.map((sim) => sim.id));
  return {
    devices: [
      ...list.simulators,
      ...ios.devices.filter((sim) => !known.has(sim.id)),
      ...list.emulators,
    ],
    available: { ios: ios.available, android },
    detail: [toolDetail(list.errors), ios.detail].filter(Boolean).join("\n") || null,
  };
}

export async function startHubDevice(
  hub: HubEndpoint | null,
  target: Pick<HubDevice, "platform" | "id">
) {
  const list = await hubInventory(hub);
  const known = (target.platform === "ios" ? list.simulators : list.emulators).find(
    (d) => d.id === target.id
  );
  let selected = known;
  if (!selected && target.platform === "ios") {
    const ios = await listSimulators();
    if (!ios.available) throw new ConflictError("iOS Simulators need Xcode.");
    if (ios.detail) throw new AppError(503, "iOS simulators could not be listed.", ios.detail);
    selected = ios.devices.find((device) => device.id === target.id);
  }
  if (!selected) throw new ConflictError("This device is no longer available.");

  const perform = async (path: string, body: object) => {
    const result = action.parse(await request(hub, path, body));
    if (!result.ok)
      throw new ConflictError(
        "The device could not start.",
        [result.error, toolDetail(result.errors ?? [])].filter(Boolean).join("\n")
      );
    return result;
  };
  let id = selected.id;
  if (!selected.booted) {
    if (known) {
      const result = await perform("/api/devices/boot", selected);
      id = result.serial ?? id;
    } else {
      // A simulator that has never booted has no hub inventory entry.
      try {
        await simctl(["boot", id], { timeout: 90_000 });
      } catch (error) {
        const current = await listDevices().catch(() => []);
        const state = current.find((sim) => sim.udid === id)?.state;
        if (state !== "Booted" && state !== "Booting")
          throw new ConflictError("The simulator could not boot.", getErrorMessage(error));
      }
    }
  }
  if (selected.platform === "ios") await perform("/vendor/serve-sim/grid/api/start", { udid: id });
  return { ...selected, id, booted: true };
}
