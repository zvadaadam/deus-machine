import type { CommandResult } from "../../engine/types.js";

export function formatJson(result: CommandResult, command: string): string {
  return JSON.stringify(
    {
      success: result.success,
      command,
      data: result.data ?? null,
      message: result.message ?? null,
      nextSteps: result.nextSteps ?? [],
      warnings: result.warnings ?? [],
    },
    null,
    2
  );
}
