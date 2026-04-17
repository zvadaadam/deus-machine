import type { CommandResult, GlobalFlags } from "../../engine/types.js";
import { formatJson } from "./json.js";
import { RED, RESET } from "./style.js";
import { formatTty } from "./tty.js";

export function printResult(result: CommandResult, commandName: string, flags: GlobalFlags): void {
  const output = flags.json ? formatJson(result, commandName) : formatTty(result, commandName);
  process.stdout.write(`${output}\n`);
}

export function printError(error: Error | string, flags: GlobalFlags): void {
  const message = typeof error === "string" ? error : error.message;

  if (flags.json) {
    const json = JSON.stringify({ success: false, error: message });
    process.stdout.write(`${json}\n`);
  } else {
    process.stderr.write(`${RED}✗ ${message}${RESET}\n`);
  }
}
