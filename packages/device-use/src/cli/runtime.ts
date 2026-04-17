import type {
  CommandContext,
  CommandExecutor,
  CommandResult,
  GlobalFlags,
} from "../engine/types.js";
import type { SimBridgeCallOptions } from "../engine/simbridge.js";
import { getBootedSimulator } from "../engine/simctl.js";
import { SessionStore } from "./session/store.js";

export interface CommandSetup {
  store: SessionStore;
  udid: string;
  simBridgeOptions: SimBridgeCallOptions | undefined;
}

export function getSimBridgeOptions(flags: GlobalFlags): SimBridgeCallOptions | undefined {
  const opts: SimBridgeCallOptions = {};
  if (flags.timeoutMs !== undefined) opts.timeout = flags.timeoutMs;
  if (flags.verbose) opts.verbose = true;
  return Object.keys(opts).length > 0 ? opts : undefined;
}

async function resolveSimulatorUdid(
  store: SessionStore,
  executor: CommandExecutor,
  simulatorFlag?: string
): Promise<string | CommandResult> {
  const udid = store.getSimulatorUdid(simulatorFlag);
  if (udid) return udid;

  const booted = await getBootedSimulator(executor);
  if (!booted) {
    return { success: false, message: "No booted simulator. Run: device-use boot <name>" };
  }
  return booted.udid;
}

export async function resolveCommandSetup(
  ctx: CommandContext
): Promise<CommandSetup | CommandResult> {
  const store = new SessionStore();
  const resolved = await resolveSimulatorUdid(store, ctx.executor, ctx.flags.simulator);
  if (typeof resolved !== "string") return resolved;
  return { store, udid: resolved, simBridgeOptions: getSimBridgeOptions(ctx.flags) };
}
