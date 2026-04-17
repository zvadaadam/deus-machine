import { z } from "zod";
import type { CommandDefinition, CommandResult, Simulator } from "../../engine/types.js";
import { listSimulators } from "../../engine/simctl.js";
import { BOLD, GRAY, GREEN, RESET } from "../output/style.js";

const schema = z.object({
  booted: z.boolean().optional(),
});

type Params = z.infer<typeof schema>;

function formatTable(simulators: Simulator[]): string {
  if (simulators.length === 0) return "No simulators found.";

  const lines: string[] = [];
  let lastRuntime = "";

  for (const sim of simulators) {
    if (sim.runtime !== lastRuntime) {
      if (lastRuntime) lines.push("");
      lines.push(`${BOLD}-- ${sim.runtime} --${RESET}`);
      lastRuntime = sim.runtime;
    }

    const stateIcon = sim.state === "Booted" ? `${GREEN}●${RESET}` : `${GRAY}○${RESET}`;
    const state = sim.state === "Booted" ? `${GREEN}Booted${RESET}` : `${GRAY}Shutdown${RESET}`;
    lines.push(`  ${stateIcon} ${sim.name}  ${state}  ${sim.udid}`);
  }

  return lines.join("\n");
}

export const listCommand: CommandDefinition<Params> = {
  name: "list",
  description: "List available simulators",
  usage: "list [--booted]",
  examples: ["list", "list --booted"],
  schema,
  async handler(params, ctx): Promise<CommandResult> {
    const simulators = await listSimulators(ctx.executor, {
      booted: params.booted,
    });

    return {
      success: true,
      data: ctx.flags.json ? simulators : formatTable(simulators),
      message: `${simulators.length} simulator${simulators.length === 1 ? "" : "s"} found`,
    };
  },
};
