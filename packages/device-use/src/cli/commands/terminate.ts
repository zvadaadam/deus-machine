import { z } from "zod";
import type { CommandDefinition, CommandResult } from "../../engine/types.js";
import { terminateApp } from "../../engine/simctl.js";
import { resolveCommandSetup } from "../runtime.js";

const schema = z.object({
  _positionals: z.array(z.string()).min(1, "Bundle identifier required"),
});

type Params = z.infer<typeof schema>;

export const terminateCommand: CommandDefinition<Params> = {
  name: "terminate",
  aliases: ["kill"],
  description: "Terminate a running app",
  usage: "terminate <bundleId>",
  examples: ["terminate com.apple.Preferences", "terminate com.apple.Maps"],
  schema,
  async handler(params, ctx): Promise<CommandResult> {
    const setup = await resolveCommandSetup(ctx);
    if (!("udid" in setup)) return setup;

    const bundleId = params._positionals[0]!;
    await terminateApp(ctx.executor, setup.udid, bundleId);

    return {
      success: true,
      message: `Terminated ${bundleId}`,
      data: ctx.flags.json ? { bundleId } : undefined,
    };
  },
};
