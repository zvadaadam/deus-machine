import { join } from "node:path";
import { agentDeviceEvents } from "../adapters/agent-device.js";
import { ScreenStudioError } from "../errors.js";
import { run, tail } from "../util/process.js";
import type { ActiveCapture, CaptureBackend } from "./backend.js";

/**
 * An iOS Simulator, recorded by agent-device (`record start --scope device`).
 * Its gesture telemetry becomes the recording's actions, so the edit knows
 * where every touch landed. Only touches made in the same agent-device
 * session reach a recording: a recording claims its device for its session.
 */
export interface SimulatorSourceSpec {
  kind: "ios-simulator";
  /** A device UDID, or "booted" for the only booted device. */
  udid: string;
  /** The agent-device session the device is driven in. Default: agent-device's own. */
  session?: string;
  /** agent-device executable. Default: $AGENT_DEVICE_BIN or `agent-device`. */
  bin?: string;
}

export interface SimulatorDevice {
  udid: string;
  name: string;
  booted: boolean;
  runtime: string;
}

interface Answer {
  success?: boolean;
  data?: Record<string, unknown>;
  error?: { message?: string; hint?: string };
}

async function agentDevice(spec: Pick<SimulatorSourceSpec, "session" | "bin">, args: string[]) {
  const bin = spec.bin ?? process.env.AGENT_DEVICE_BIN ?? "agent-device";
  const env = { ...process.env, ...(spec.session ? { AGENT_DEVICE_SESSION: spec.session } : {}) };
  // The first use builds agent-device's runner with Xcode, which takes minutes.
  const result = await run(bin, [...args, "--json"], { env, timeoutMs: 300_000 });
  let answer: Answer = {};
  try {
    answer = JSON.parse(result.stdout) as Answer;
  } catch {
    // Not JSON: reported below with what it printed.
  }
  if (result.code !== 0 || !answer.success) {
    throw new ScreenStudioError(
      "capture_failed",
      `agent-device ${args[0]} ${args[1] ?? ""}`.trim() +
        `: ${answer.error?.message ?? tail(result.stderr || result.stdout)}`,
      answer.error?.hint ? { hint: answer.error.hint } : {}
    );
  }
  return answer.data ?? {};
}

export async function listSimulators(spec: Pick<SimulatorSourceSpec, "bin"> = {}) {
  const data = await agentDevice(spec, ["devices", "--platform", "ios"]);
  const devices = (data.devices ?? []) as Array<{
    id: string;
    name: string;
    kind?: string;
    booted?: boolean;
    osVersion?: string;
  }>;
  return devices
    .filter((d) => d.kind === "simulator")
    .map(
      (d): SimulatorDevice => ({
        udid: d.id,
        name: d.name,
        booted: d.booted === true,
        runtime: `iOS ${d.osVersion ?? ""}`.trim(),
      })
    );
}

export async function simulatorBackend(spec: SimulatorSourceSpec): Promise<CaptureBackend> {
  const devices = await listSimulators(spec);
  const booted = devices.filter((d) => d.booted);
  // "booted" names the only booted device: with several, picking one would
  // record a simulator other than the one being used.
  if (spec.udid === "booted" && booted.length > 1) {
    throw new ScreenStudioError("source_unavailable", "Several simulators are booted", {
      hint: `Name one: ${booted.map((d) => `${d.name} (${d.udid})`).join(", ")}`,
    });
  }
  const device =
    spec.udid === "booted"
      ? booted[0]
      : devices.find((d) => d.udid.toLowerCase() === spec.udid.toLowerCase());
  if (!device) {
    throw new ScreenStudioError(
      "source_not_found",
      spec.udid === "booted" ? "No simulator is booted" : `No simulator ${spec.udid}`,
      {
        hint: booted.length
          ? `Booted: ${booted.map((d) => `${d.name} (${d.udid})`).join(", ")}`
          : "Boot one with `agent-device boot --platform ios` or open Simulator.app.",
      }
    );
  }
  if (!device.booted) {
    throw new ScreenStudioError("source_unavailable", `${device.name} is not booted`, {
      hint: `Boot it first: agent-device boot --udid ${device.udid}`,
    });
  }
  return {
    id: `ios-simulator:${device.udid}`,
    kind: "ios-simulator",
    backend: "agent-device",
    label: `${device.name} (${device.runtime})`,
    details: { udid: device.udid, name: device.name, runtime: device.runtime },
    async start(context): Promise<ActiveCapture> {
      const path = join(context.mediaDir, "screen.mp4");
      // Raw video: the render draws the touches itself, from the telemetry.
      const args = ["--hide-touches", "--scope", "device", "--udid", device.udid];
      await agentDevice(spec, ["record", "start", path, ...args]);
      // agent-device times its telemetry from its recording's start, which it
      // takes ~50 ms before `record start` answers.
      const started = Date.now() - 50;
      return {
        mediaStartEpochMs: started,
        uncertaintyMs: 100,
        clockMethod: "agent-device record start's answer",
        pointerInPixels: "none",
        childPids: [],
        stats: () => ({ frames: null }),
        async stop() {
          const data = await agentDevice(spec, ["record", "stop"]);
          const telemetry = typeof data.telemetryPath === "string" ? data.telemetryPath : null;
          const events = telemetry
            ? (await agentDeviceEvents(telemetry)).map((event) =>
                event.kind === "action"
                  ? {
                      ...event,
                      at: started + (event.at ?? 0),
                      ...(event.endAt !== undefined ? { endAt: started + event.endAt } : {}),
                    }
                  : event
              )
            : [];
          // The video holds frames only where the screen changed; renderers pad
          // a still ending by holding the last frame.
          return { path, warnings: telemetry ? [] : ["agent-device wrote no telemetry"], events };
        },
      };
    },
  };
}
