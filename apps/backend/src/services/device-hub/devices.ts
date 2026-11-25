import { z } from "zod";
import type { HubDevice } from "@shared/types/device-hub";
import { AppError, ConflictError } from "../../lib/errors";
import type { HubEndpoint } from "./manager";

const device = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  platform: z.enum(["ios", "android"]),
  booted: z.boolean(),
});
const errors = z.array(z.object({ message: z.string(), error: z.string().optional() }));
const inventory = z.object({ simulators: z.array(device), emulators: z.array(device), errors });
const action = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  errors: errors.optional(),
  serial: z.string().optional(),
});

function reasons(issues: z.infer<typeof errors>) {
  return issues.map((issue) => {
    const detail = issue.error?.split("\n", 1)[0] ?? "";
    if (detail.includes("ENOENT") && issue.message.startsWith("[android-utils]"))
      return `Android SDK unavailable. ${detail}`;
    if (
      issue.message.startsWith("[apple-utils]") &&
      /ENOENT|unable to find utility|command line tools|invalid active developer path|requires Xcode/i.test(
        issue.message + " " + issue.error
      )
    )
      return `iOS requires Xcode. ${issue.message} ${detail}`.trim();
    return `${issue.message} ${detail}`.trim();
  });
}

async function request(hub: HubEndpoint | null, path: string, body?: object) {
  if (!hub) throw new ConflictError("Device Hub is not running.");
  let res: Response;
  try {
    res = await fetch(hub.origin + path, {
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
    throw new AppError(502, "Device Hub did not answer the device request.");
  }
}

export async function listHubDevices(hub: HubEndpoint | null) {
  const list = inventory.parse(await request(hub, "/api/devices"));
  return { devices: [...list.simulators, ...list.emulators], warnings: reasons(list.errors) };
}

export async function startHubDevice(
  hub: HubEndpoint | null,
  target: Pick<HubDevice, "platform" | "id">
) {
  const { devices } = await listHubDevices(hub);
  const selected = devices.find((d) => d.platform === target.platform && d.id === target.id);
  if (!selected) throw new ConflictError("This device is no longer available.");
  const perform = async (path: string, body: object) => {
    const result = action.parse(await request(hub, path, body));
    if (!result.ok)
      throw new ConflictError(
        [result.error, ...reasons(result.errors ?? [])].filter(Boolean).join(" ") ||
          "Device Hub could not start this device."
      );
    return result;
  };
  let id = selected.id;
  if (!selected.booted) {
    const result = await perform("/api/devices/boot", selected);
    id = result.serial ?? id;
  }
  // simctl boot alone does not attach a capture session.
  if (selected.platform === "ios") await perform("/vendor/serve-sim/grid/api/start", { udid: id });
  return { ...selected, id, booted: true };
}
