import { sendCommand } from "@/platform/ws/query-protocol-client";
import type { CommandName } from "@shared/types/query-protocol";
import { REMOTE_BROWSER_COMMAND_TIMEOUT_MS } from "./remoteBrowserConstants";

export async function sendBrowserCommand(
  command: CommandName,
  params: Record<string, unknown>,
  timeoutMs = REMOTE_BROWSER_COMMAND_TIMEOUT_MS
): Promise<Record<string, unknown>> {
  const result = await sendCommand(command, params, timeoutMs);
  if (!result.accepted) {
    throw new Error(result.error || `${command} failed`);
  }
  return result;
}
