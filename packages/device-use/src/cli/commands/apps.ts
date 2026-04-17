import { z } from "zod";
import type { AppInfo, CommandDefinition, CommandResult } from "../../engine/types.js";
import { listApps } from "../../engine/simctl.js";
import { resolveCommandSetup } from "../runtime.js";
import { BOLD, DIM, RESET } from "../output/style.js";

const schema = z.object({
  user: z.boolean().optional(),
  system: z.boolean().optional(),
});

type Params = z.infer<typeof schema>;

function formatTable(apps: AppInfo[]): string {
  if (apps.length === 0) return "No apps found.";

  const groups: Record<string, AppInfo[]> = { User: [], System: [] };
  for (const a of apps) groups[a.type]!.push(a);

  const lines: string[] = [];
  for (const type of ["User", "System"] as const) {
    const group = groups[type];
    if (group.length === 0) continue;
    lines.push(`${BOLD}-- ${type} (${group.length}) --${RESET}`);
    const maxNameLen = Math.min(Math.max(...group.map((a) => a.name.length)), 30);
    for (const a of group) {
      const name = a.name.length > 30 ? a.name.slice(0, 29) + "…" : a.name;
      const version = a.version ? ` ${DIM}v${a.version}${RESET}` : "";
      lines.push(`  ${name.padEnd(maxNameLen)}  ${a.bundleId}${version}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export const appsCommand: CommandDefinition<Params> = {
  name: "apps",
  description: "List installed apps with their bundle identifiers",
  usage: "apps [--user|--system]",
  examples: ["apps", "apps --user", "apps --json"],
  schema,
  async handler(params, ctx): Promise<CommandResult> {
    const setup = await resolveCommandSetup(ctx);
    if (!("udid" in setup)) return setup;

    const filter = params.user ? "User" : params.system ? "System" : "all";
    const apps = await listApps(ctx.executor, setup.udid, { type: filter });

    const userCount = apps.filter((a) => a.type === "User").length;
    const systemCount = apps.length - userCount;

    return {
      success: true,
      message: `${apps.length} apps (${userCount} user, ${systemCount} system)`,
      data: ctx.flags.json ? apps : formatTable(apps),
      nextSteps: apps[0]
        ? [
            { command: `launch ${apps[0].bundleId}`, label: `Launch ${apps[0].name}` },
            { command: `appstate ${apps[0].bundleId}`, label: "Check state" },
          ]
        : [],
    };
  },
};
