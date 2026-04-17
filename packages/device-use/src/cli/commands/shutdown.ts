import { z } from "zod";
import type { CommandDefinition, CommandResult } from "../../engine/types.js";
import {
  getBootedSimulator,
  listSimulators,
  resolveSimulator,
  shutdownSimulator,
} from "../../engine/simctl.js";

const schema = z.object({
  _positionals: z.array(z.string()).optional(),
  all: z.boolean().optional(),
  dryRun: z.boolean().optional(),
});

type Params = z.infer<typeof schema>;

export const shutdownCommand: CommandDefinition<Params> = {
  name: "shutdown",
  description: "Shutdown a simulator",
  usage: "shutdown [name|UDID] [--all] [--dry-run]",
  examples: ['shutdown "iPhone 17"', "shutdown --all", "shutdown --all --dry-run"],
  schema,
  async handler(params, ctx): Promise<CommandResult> {
    if (params.all) {
      if (params.dryRun) {
        const booted = await listSimulators(ctx.executor, { booted: true });
        return {
          success: true,
          message: `[dry-run] Would shut down ${booted.length} simulator(s)`,
          data: {
            dryRun: true,
            targets: booted.map((s) => ({ udid: s.udid, name: s.name })),
          },
        };
      }

      const result = await ctx.executor(["xcrun", "simctl", "shutdown", "all"]);
      return {
        success: result.success,
        message: result.success ? "All simulators shut down" : `Failed: ${result.error}`,
        data: result.success ? { shutdownAll: true } : undefined,
      };
    }

    const nameOrUdid = params._positionals?.[0] ?? ctx.flags.simulator;
    const sim = nameOrUdid
      ? await resolveSimulator(ctx.executor, nameOrUdid)
      : await getBootedSimulator(ctx.executor);

    if (!sim) {
      return {
        success: false,
        message:
          'No booted simulator found.\nUsage: device-use shutdown <name|UDID>\nExample: device-use shutdown "iPhone 17"',
      };
    }

    if (params.dryRun) {
      return {
        success: true,
        message: `[dry-run] Would shut down ${sim.name} (${sim.udid})`,
        data: { dryRun: true, target: { udid: sim.udid, name: sim.name, state: sim.state } },
      };
    }

    await shutdownSimulator(ctx.executor, sim.udid);
    return {
      success: true,
      message: `Shut down ${sim.name} (${sim.udid})`,
      data: { udid: sim.udid, name: sim.name },
    };
  },
};
