import { z } from "zod";
import type { CommandDefinition, CommandResult } from "../../engine/types.js";
import { bootSimulator, resolveSimulator } from "../../engine/simctl.js";

const schema = z.object({
  _positionals: z.array(z.string()).min(1, "Simulator name or UDID required"),
});

type Params = z.infer<typeof schema>;

export const bootCommand: CommandDefinition<Params> = {
  name: "boot",
  description: "Boot a simulator by name or UDID",
  usage: "boot <name|UDID>",
  examples: [
    'boot "iPhone 17 Pro"',
    'boot "iPhone 17" --json',
    "boot AAAAAAAA-1111-2222-3333-444444444444",
  ],
  schema,
  async handler(params, ctx): Promise<CommandResult> {
    const nameOrUdid = params._positionals[0]!;
    const sim = await resolveSimulator(ctx.executor, nameOrUdid);

    if (sim.state === "Booted") {
      return {
        success: true,
        message: `${sim.name} (${sim.udid}) is already booted`,
        data: { udid: sim.udid, name: sim.name, state: "Booted" },
        nextSteps: [
          { command: "snapshot -i", label: "Observe the UI" },
          { command: `session set --simulator ${sim.udid}`, label: "Set as default" },
        ],
      };
    }

    await bootSimulator(ctx.executor, sim.udid);

    return {
      success: true,
      message: `Booted ${sim.name} (${sim.udid})`,
      data: { udid: sim.udid, name: sim.name, state: "Booted" },
      nextSteps: [
        { command: `session set --simulator ${sim.udid}`, label: "Set as default" },
        { command: "open", label: "Open Simulator.app" },
      ],
    };
  },
};
