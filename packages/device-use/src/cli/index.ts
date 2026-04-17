import { finalizeArgsForCommand, parseArgs } from "./args.js";
import { dispatch, getCommandFlagKeys, listCommands, register, resolve } from "./registry.js";
import { printError, printResult } from "./output/formatter.js";
import { BOLD, RESET } from "./output/style.js";
import { createExecutor } from "../engine/utils/exec.js";
import { getVersion } from "./version.js";

import { appsCommand } from "./commands/apps.js";
import { appstateCommand } from "./commands/appstate.js";
import { bootCommand } from "./commands/boot.js";
import { doctorCommand } from "./commands/doctor.js";
import { fillCommand } from "./commands/fill.js";
import { installCommand } from "./commands/install.js";
import { launchCommand } from "./commands/launch.js";
import { listCommand } from "./commands/list.js";
import { openCommand } from "./commands/open.js";
import { openUrlCommand } from "./commands/open-url.js";
import { permissionCommand } from "./commands/permission.js";
import { queryCommand } from "./commands/query.js";
import { screenshotCommand } from "./commands/screenshot.js";
import { sessionCommand } from "./commands/session.js";
import { shutdownCommand } from "./commands/shutdown.js";
import { snapshotCommand } from "./commands/snapshot.js";
import { streamCommand } from "./commands/stream.js";
import { swipeCommand } from "./commands/swipe.js";
import { tapCommand } from "./commands/tap.js";
import { terminateCommand } from "./commands/terminate.js";
import { typeCommand } from "./commands/type.js";
import { waitForCommand } from "./commands/wait-for.js";

for (const cmd of [
  listCommand,
  bootCommand,
  shutdownCommand,
  openCommand,
  sessionCommand,
  snapshotCommand,
  queryCommand,
  tapCommand,
  swipeCommand,
  typeCommand,
  fillCommand,
  screenshotCommand,
  streamCommand,
  waitForCommand,
  openUrlCommand,
  appsCommand,
  appstateCommand,
  launchCommand,
  terminateCommand,
  permissionCommand,
  doctorCommand,
  installCommand,
]) {
  register(cmd);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);

  if (parsed.command === "version" || parsed.flags["version"]) {
    process.stdout.write(`device-use ${getVersion()}\n`);
    return;
  }

  if (!parsed.command || parsed.command === "help") {
    printHelp();
    return;
  }

  const definition = resolve(parsed.command);
  const finalized = finalizeArgsForCommand(parsed, getCommandFlagKeys(definition));

  const executor = createExecutor({ timeout: finalized.globalFlags.timeoutMs });
  const ctx = { executor, flags: finalized.globalFlags };

  const result = await dispatch(finalized.command, finalized.flags, finalized.positionals, ctx);

  printResult(result, finalized.command, finalized.globalFlags);

  if (!result.success) {
    process.exitCode = 1;
  }
}

function printHelp(): void {
  const commands = listCommands();
  const maxLen = Math.max(...commands.map((c) => c.name.length));
  const commandLines = commands
    .map((cmd) => `  ${cmd.name.padEnd(maxLen + 2)} ${cmd.description}`)
    .join("\n");

  process.stdout.write(`
${BOLD}device-use${RESET} — iOS Simulator automation for AI agents

${BOLD}Usage:${RESET}
  device-use <command> [options]

${BOLD}Commands:${RESET}
${commandLines}

${BOLD}Global Options:${RESET}
  --json              Force JSON output
  --verbose, -v       Verbose logging
  --simulator <udid>  Target specific simulator
  --no-color          Disable colors
  --timeout <sec>     Command timeout

${BOLD}Examples:${RESET}
  device-use list
  device-use boot "iPhone 17 Pro"
  device-use snapshot -i
  device-use tap @e1
  device-use type "hello@example.com"
  device-use screenshot login.png
`);
}

main().catch((error: unknown) => {
  const flags = { json: !process.stdout.isTTY, verbose: false, noColor: false };
  printError(error instanceof Error ? error : new Error(String(error)), flags);
  process.exitCode = 1;
});
