import { sendCommand } from "@/platform/ws/query-protocol-client";

const REMOTE_COMMAND_TIMEOUT_MS = 20_000;

export function disposeRemoteBrowserTab(tabId: string): void {
  sendCommand("browser:close", { tabId }, REMOTE_COMMAND_TIMEOUT_MS).catch(() => {});
}
