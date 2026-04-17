import type { CommandResult } from "../../engine/types.js";
import { RESET, statusIcon, YELLOW } from "./style.js";

export function formatTty(result: CommandResult, _command: string): string {
  return [
    result.message && `${statusIcon(result.success ? "ok" : "error")} ${result.message}`,
    ...(result.warnings ?? []).map((w) => `${YELLOW}⚠ ${w}${RESET}`),
    typeof result.data === "string" && result.data,
    ...(result.nextSteps?.length
      ? [`\nNext: ${result.nextSteps.map((s) => `device-use ${s.command}`).join(" | ")}`]
      : []),
  ]
    .filter(Boolean)
    .join("\n");
}
