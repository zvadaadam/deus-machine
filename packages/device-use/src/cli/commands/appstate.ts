import { z } from "zod";
import type { CommandDefinition, CommandResult } from "../../engine/types.js";
import { getAppState } from "../../engine/simctl.js";
import { resolveCommandSetup } from "../runtime.js";

const schema = z.object({
  _positionals: z.array(z.string()).min(1, "Bundle identifier required"),
});

type Params = z.infer<typeof schema>;

export const appstateCommand: CommandDefinition<Params> = {
  name: "appstate",
  description: "Check if an app is installed and running",
  usage: "appstate <bundleId>",
  examples: ["appstate com.apple.Preferences", "appstate ai.deus.machine --json"],
  schema,
  async handler(params, ctx): Promise<CommandResult> {
    const setup = await resolveCommandSetup(ctx);
    if (!("udid" in setup)) return setup;

    const bundleId = params._positionals[0]!;
    const state = await getAppState(ctx.executor, setup.udid, bundleId);

    const runMsg = state.running
      ? `running (pid ${state.pid})`
      : state.installed
        ? "installed, not running"
        : "not installed";

    // Normalize: always include pid as null when not running, for JSON stability.
    const normalized = {
      bundleId: state.bundleId,
      installed: state.installed,
      running: state.running,
      pid: state.pid ?? null,
    };

    return {
      success: true,
      message: `${bundleId}: ${runMsg}`,
      data: ctx.flags.json ? normalized : undefined,
      nextSteps: state.installed
        ? state.running
          ? [{ command: `terminate ${bundleId}`, label: "Terminate" }]
          : [{ command: `launch ${bundleId}`, label: "Launch" }]
        : [{ command: "apps --user", label: "See installed apps" }],
    };
  },
};
