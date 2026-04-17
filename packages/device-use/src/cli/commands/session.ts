import { z } from "zod";
import type { CommandDefinition, CommandResult } from "../../engine/types.js";
import { resolveSimulator } from "../../engine/simctl.js";
import { SessionStore } from "../session/store.js";
import type { SessionDefaults } from "../session/types.js";

const schema = z.object({
  _positionals: z.array(z.string()).optional(),
  scheme: z.string().optional(),
  simulator: z.string().optional(),
  workspace: z.string().optional(),
  project: z.string().optional(),
  bundleId: z.string().optional(),
  config: z.string().optional(),
});

type Params = z.infer<typeof schema>;

export const sessionCommand: CommandDefinition<Params> = {
  name: "session",
  description: "Manage session defaults",
  usage: "session <set|show|clear> [--scheme <name>] [--simulator <name|UDID>]",
  examples: [
    "session show",
    'session set --simulator "iPhone 17"',
    "session set --scheme MyApp --workspace /path/to/MyApp.xcworkspace",
    "session clear",
  ],
  schema,
  async handler(params, ctx): Promise<CommandResult> {
    const subcommand = params._positionals?.[0] ?? "show";
    const store = new SessionStore();

    switch (subcommand) {
      case "set": {
        const updates: Partial<SessionDefaults> = {};
        if (params.scheme) updates.scheme = params.scheme;
        if (params.simulator) {
          const simulator = await resolveSimulator(ctx.executor, params.simulator);
          updates.simulatorUdid = simulator.udid;
          updates.simulatorName = simulator.name;
        }
        if (params.workspace) updates.workspacePath = params.workspace;
        if (params.project) updates.projectPath = params.project;
        if (params.bundleId) updates.bundleId = params.bundleId;
        if (params.config) updates.configuration = params.config;

        store.setDefaults(updates);

        return {
          success: true,
          message: "Session defaults updated",
          data: store.getDefaults(),
        };
      }

      case "show": {
        const defaults = store.getDefaults();
        const hasDefaults = Object.values(defaults).some((v) => v !== undefined);

        return {
          success: true,
          message: hasDefaults ? "Session defaults" : "No session defaults set",
          data: defaults,
        };
      }

      case "clear": {
        store.clearDefaults();
        store.clearRefs();
        return { success: true, message: "Session cleared" };
      }

      default:
        return {
          success: false,
          message: `Unknown subcommand: ${subcommand}. Use set, show, or clear.`,
        };
    }
  },
};
