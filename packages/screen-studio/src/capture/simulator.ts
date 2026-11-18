import { spawn } from "node:child_process";
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

function command(spec: Pick<SimulatorSourceSpec, "session" | "bin">) {
  const bin = spec.bin ?? process.env.AGENT_DEVICE_BIN ?? "agent-device";
  const env = { ...process.env, ...(spec.session ? { AGENT_DEVICE_SESSION: spec.session } : {}) };
  return { bin, env };
}

async function agentDevice(spec: Pick<SimulatorSourceSpec, "session" | "bin">, args: string[]) {
  const { bin, env } = command(spec);
  // The first use builds agent-device's runner with Xcode, which takes minutes.
  const result = await run(bin, [...args, "--json"], { env, timeoutMs: 300_000 });
  let answer: Answer = {};
  try {
    answer = JSON.parse(result.stdout) as Answer;
  } catch {
    // Not JSON: reported below with what it printed.
  }
  if (result.code !== 0 || !answer.success) {
    const error = new ScreenStudioError(
      "capture_failed",
      `agent-device ${args[0]} ${args[1] ?? ""}`.trim() +
        `: ${answer.error?.message ?? tail(result.stderr || result.stdout)}`,
      answer.error?.hint ? { hint: answer.error.hint } : {}
    );
    // Whether agent-device answered at all (a refusal), or died or timed out first.
    throw Object.assign(error, { answered: answer.success !== undefined });
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
      try {
        await agentDevice(spec, ["record", "start", path, ...args]);
      } catch (err) {
        // No answer at all: the recording may have begun, so end it. A refusal
        // leaves the device alone (another recording may hold it).
        if (!(err as { answered?: boolean }).answered) {
          await agentDevice(spec, ["record", "stop"]).catch(() => {});
        }
        throw err;
      }
      // agent-device times its telemetry from its recording's start, which it
      // takes ~50 ms before `record start` answers. Measured against its video,
      // a touch is off by up to ~0.8 s either way (recorded here; the edit does
      // not read it).
      const started = Date.now() - 50;
      // agent-device records in its own daemon: should this process die before
      // stop, a detached watcher runs `record stop` for the session, so nothing
      // records on, holds the device or keeps the daemon alive.
      const { bin, env } = command(spec);
      const watch = 'while kill -0 "$1" 2>/dev/null; do sleep 2; done; exec "$2" record stop';
      const watcher = spawn("/bin/sh", ["-c", watch, "sh", String(process.pid), bin], {
        env,
        detached: true,
        stdio: "ignore",
      });
      // A watcher that could not start costs only this protection, never the owner.
      watcher.on("error", () => {});
      watcher.unref();
      return {
        mediaStartEpochMs: started,
        uncertaintyMs: 800,
        clockMethod: "agent-device record start's answer",
        pointerInPixels: "none",
        childPids: watcher.pid ? [watcher.pid] : [],
        stats: () => ({ frames: null }),
        async stop() {
          const data = await agentDevice(spec, ["record", "stop"]);
          // Only now: had the stop not reached agent-device, the watcher still ends the take.
          watcher.kill();
          const telemetry = typeof data.telemetryPath === "string" ? data.telemetryPath : null;
          // What agent-device says went wrong (a recording ended early, an overlay
          // it could not draw), in its own words.
          const warnings = [data.warning, data.overlayWarning].filter(
            (warning): warning is string => typeof warning === "string" && warning !== ""
          );
          if (!telemetry) warnings.push("agent-device wrote no telemetry");
          // The video is the recording: telemetry that cannot be read costs the
          // touches, not the take.
          const touches = telemetry
            ? await agentDeviceEvents(telemetry).catch((err: Error) => {
                warnings.push(err.message);
                return [];
              })
            : [];
          const events = touches.map((event) =>
            event.kind === "action"
              ? {
                  ...event,
                  at: started + (event.at ?? 0),
                  ...(event.endAt !== undefined ? { endAt: started + event.endAt } : {}),
                }
              : event
          );
          // The video holds frames only where the screen changed; renderers pad
          // a still ending by holding the last frame.
          return { path, warnings, events };
        },
      };
    },
  };
}
