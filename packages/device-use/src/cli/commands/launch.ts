import { z } from "zod";
import type { CommandDefinition, CommandResult } from "../../engine/types.js";
import { launchApp, terminateApp } from "../../engine/simctl.js";
import { resolveCommandSetup } from "../runtime.js";

const schema = z.object({
  _positionals: z.array(z.string()).min(1, "Bundle identifier required"),
  relaunch: z.boolean().optional(),
});

type Params = z.infer<typeof schema>;

export const launchCommand: CommandDefinition<Params> = {
  name: "launch",
  description: "Launch an app by bundle identifier",
  usage: "launch <bundleId> [--relaunch]",
  examples: ["launch com.apple.Preferences", "launch com.apple.Maps --relaunch"],
  schema,
  async handler(params, ctx): Promise<CommandResult> {
    const setup = await resolveCommandSetup(ctx);
    if (!("udid" in setup)) return setup;

    const bundleId = params._positionals[0]!;

    if (params.relaunch) {
      // Ignore failure — app may not be running.
      try {
        await terminateApp(ctx.executor, setup.udid, bundleId);
      } catch {
        /* swallow — relaunch should proceed even if terminate fails */
      }
    }

    const pidStr = await launchApp(ctx.executor, setup.udid, bundleId);
    const pid = Number(pidStr) || undefined;

    return {
      success: true,
      message: pid ? `Launched ${bundleId} (pid ${pid})` : `Launched ${bundleId}`,
      data: ctx.flags.json ? { bundleId, pid: pid ?? null } : undefined,
      nextSteps: [
        { command: "snapshot -i", label: "Observe the UI" },
        { command: `terminate ${bundleId}`, label: "Terminate" },
      ],
    };
  },
};
