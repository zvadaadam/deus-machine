import { sendCommand } from "@/platform/ws/query-protocol-client";
import { REMOTE_BROWSER_COMMAND_TIMEOUT_MS } from "./remoteBrowserConstants";

export function disposeRemoteBrowserTab(tabId: string): void {
  sendCommand("browser:close", { tabId }, REMOTE_BROWSER_COMMAND_TIMEOUT_MS).catch(() => {});
}
