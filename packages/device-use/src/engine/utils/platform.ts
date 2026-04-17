import type { CommandExecutor } from "../types.js";

export async function getXcodePath(executor: CommandExecutor): Promise<string | null> {
  const result = await executor(["xcode-select", "-p"]);
  return result.success ? result.output.trim() : null;
}

export async function hasSimctl(executor: CommandExecutor): Promise<boolean> {
  const result = await executor(["xcrun", "simctl", "help"]);
  return result.success;
}
