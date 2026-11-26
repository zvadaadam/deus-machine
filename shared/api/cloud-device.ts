import { z } from "zod";
import {
  CloudSimulatorPlatformSchema,
  type CloudSimulatorEvent,
  type CloudSimulatorExecResult,
  type CloudSimulatorStatus,
} from "../events";
import { out, read, write } from "./op";
import { stream } from "./stream";

const workspaceId = z.object({ workspaceId: z.string().min(1) });
/** Without a platform: the workspace's default device (start), every running one (stop), the only one (exec). */
const cloudDevice = workspaceId.extend({ platform: CloudSimulatorPlatformSchema.optional() });

/** The workspace's cloud device as the platform reports it now; null when it knows of none. */
export const cloudSimulator = read({
  name: "cloudSimulator",
  input: workspaceId,
  output: out<CloudSimulatorStatus | null>(),
});

/**
 * Ask the sandbox to boot a device. The answer only says the sandbox was
 * reached; the device's progress arrives as `cloudSimulatorEvents` status events.
 */
export const cloudSimStart = write({
  name: "cloudSimStart",
  input: cloudDevice,
  output: out<void>(),
});

/** Ask the sandbox to stop a device; like starting, the outcome arrives as events. */
export const cloudSimStop = write({
  name: "cloudSimStop",
  input: cloudDevice,
  output: out<void>(),
});

/**
 * Do one thing on the cloud device (`press`, `fill`, `home`, `screenshot`, …).
 * Any verb counts as activity for the platform's idle stop. A screenshot's
 * image arrives as a `cloudSimulatorEvents` event, not in the answer.
 */
export const cloudSimExec = write({
  name: "cloudSimExec",
  input: cloudDevice.extend({ verb: z.string().min(1), args: z.array(z.string()).optional() }),
  output: out<CloudSimulatorExecResult>(),
});

/** A workspace's cloud device: its status, screenshots and the results of actions on it. */
export const cloudSimulatorEvents = stream({
  name: "cloudSimulatorEvents",
  scope: z.object({ workspaceId: z.string() }),
  event: out<CloudSimulatorEvent>(),
});
