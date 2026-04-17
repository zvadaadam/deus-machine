import { z } from "zod";
import type { CommandDefinition, CommandResult } from "../../engine/types.js";

const schema = z.object({});
type Params = z.infer<typeof schema>;

export const openCommand: CommandDefinition<Params> = {
  name: "open",
  description: "Open the Simulator.app window",
  usage: "open",
  examples: ["open"],
  schema,
  async handler(_params, ctx): Promise<CommandResult> {
    const result = await ctx.executor(["open", "-a", "Simulator"]);

    if (!result.success) {
      return { success: false, message: `Failed to open Simulator.app: ${result.error}` };
    }

    return {
      success: true,
      message: "Opened Simulator.app",
      nextSteps: [{ command: "list --booted", label: "Check booted simulators" }],
    };
  },
};
