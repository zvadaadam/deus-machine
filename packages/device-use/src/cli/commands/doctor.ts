import { z } from "zod";
import type { CommandDefinition, CommandResult } from "../../engine/types.js";
import { isBridgeAvailable } from "../../engine/simbridge.js";
import { getBootedSimulator } from "../../engine/simctl.js";
import { getXcodePath, hasSimctl } from "../../engine/utils/platform.js";
import { statusIcon } from "../output/style.js";
import { getSimBridgeOptions } from "../runtime.js";

const schema = z.object({});
type Params = z.infer<typeof schema>;

interface CheckResult {
  name: string;
  status: "ok" | "warn" | "error";
  detail: string;
}

export const doctorCommand: CommandDefinition<Params> = {
  name: "doctor",
  description: "Check environment and dependencies",
  usage: "doctor",
  examples: ["doctor", "doctor --json"],
  schema,
  async handler(_params, ctx): Promise<CommandResult> {
    const checks: CheckResult[] = [];

    const xcodePath = await getXcodePath(ctx.executor);
    if (xcodePath) {
      checks.push({ name: "Xcode", status: "ok", detail: xcodePath });
    } else {
      checks.push({
        name: "Xcode",
        status: "error",
        detail: "Not found. Install Xcode and run: xcode-select --install",
      });
    }

    const simctlOk = await hasSimctl(ctx.executor);
    checks.push({
      name: "simctl",
      status: simctlOk ? "ok" : "error",
      detail: simctlOk ? "Available" : "Not found",
    });

    const bridge = await isBridgeAvailable(getSimBridgeOptions(ctx.flags));
    checks.push({
      name: "simbridge",
      status: bridge.available ? "ok" : "error",
      detail: bridge.available ? "Available" : (bridge.reason ?? "Not available"),
    });

    const booted = await getBootedSimulator(ctx.executor);
    checks.push({
      name: "Booted simulator",
      status: booted ? "ok" : "warn",
      detail: booted ? `${booted.name} (${booted.udid})` : "None",
    });

    const allOk = checks.every((c) => c.status === "ok");
    const hasErrors = checks.some((c) => c.status === "error");

    if (ctx.flags.json) {
      return {
        success: !hasErrors,
        data: checks,
        message: allOk ? "All checks passed" : "Some checks failed",
      };
    }

    const lines = checks.map((c) => `  ${statusIcon(c.status)} ${c.name.padEnd(20)} ${c.detail}`);

    return {
      success: !hasErrors,
      message: allOk ? "All checks passed" : "Some checks need attention",
      data: `Environment:\n${lines.join("\n")}`,
    };
  },
};
