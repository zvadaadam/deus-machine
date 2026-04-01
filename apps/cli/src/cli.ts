#!/usr/bin/env node

/**
 * Deus CLI — run Deus from the command line.
 *
 * Smart default:
 *   npx deus-machine        Desktop → install/launch app. Server → headless.
 *
 * Commands:
 *   deus                    Auto-detect best mode
 *   deus start              Start headless server (backend + agent-server)
 *   deus install            Download and install the desktop app
 *   deus pair               Generate a pairing code for remote access
 *   deus login              Configure AI agent authentication
 *   deus status             Show server info and connected devices
 */

import { parseArgs } from "node:util";
import { start } from "./start.js";
import { installDesktop, hasDisplay, findInstalledApp, launchDesktop } from "./desktop.js";
import { pair } from "./pair.js";
import { runAuthSetup } from "./login.js";
import { showStatus } from "./status.js";
import {
  animatedBanner,
  banner,
  c,
  blank,
  info,
  hint,
  success,
  error,
} from "./ui.js";

function printHelp(version: string) {
  banner(version);
  console.log(`  ${c.bold("Usage:")}   deus ${c.dim("[command] [options]")}`);
  blank();

  console.log(`  ${c.bold("Commands:")}`);
  console.log(`    ${c.cyan("(none)")}        Auto-detect: launch desktop app or start server`);
  console.log(`    ${c.cyan("start")}        Start headless server ${c.dim("(backend + agent-server)")}`);
  console.log(`    ${c.cyan("install")}      Download and install the desktop app`);
  console.log(`    ${c.cyan("pair")}         Generate a pairing code for remote access`);
  console.log(`    ${c.cyan("login")}        Configure AI agent authentication`);
  console.log(`    ${c.cyan("status")}       Show server info and connected devices`);
  blank();

  console.log(`  ${c.bold("Options")} ${c.dim("(start):")}`);
  console.log(`    ${c.cyan("--data-dir")}   Directory for database and data files`);
  blank();

  console.log(`  ${c.bold("Options")} ${c.dim("(install):")}`);
  console.log(`    ${c.cyan("--version")}    Install a specific version ${c.dim("(default: latest)")}`);
  blank();

  console.log(`  ${c.bold("Examples:")}`);
  console.log(`    ${c.dim("$")} deus                    ${c.dim("# auto-detect mode")}`);
  console.log(`    ${c.dim("$")} deus start               ${c.dim("# run headless server")}`);
  console.log(`    ${c.dim("$")} deus install              ${c.dim("# install desktop app")}`);
  console.log(`    ${c.dim("$")} deus pair                 ${c.dim("# generate pairing code")}`);
  console.log(`    ${c.dim("$")} deus login                ${c.dim("# set up AI agent auth")}`);
  console.log(`    ${c.dim("$")} deus status               ${c.dim("# show server info")}`);
  blank();

  console.log(`  ${c.bold("Quick start:")}`);
  console.log(`    ${c.dim("$")} npx deus-machine          ${c.dim("# just works, no install needed")}`);
  blank();
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] && !args[0].startsWith("-") ? args[0] : null;
  const commandArgs = command ? args.slice(1) : args;

  // Load version once
  const pkg = await import("../package.json", { with: { type: "json" } });
  const version = pkg.default.version;

  // Version (plain output, no banner)
  if (args.includes("--version") || args.includes("-v")) {
    console.log(version);
    process.exit(0);
  }

  // Help
  if (command === "help" || args.includes("--help") || args.includes("-h")) {
    printHelp(version);
    process.exit(0);
  }

  // Commands that don't need the full banner
  const quickCommands = ["pair", "status", "login"];
  if (!command || !quickCommands.includes(command)) {
    await animatedBanner(version);
  }

  // Resolve command
  const resolvedCommand = command ?? autoDetect();

  switch (resolvedCommand) {
    // ── Start headless server ──────────────────────────────────────
    case "start":
    case "serve": { // backward compat
      const { values } = parseArgs({
        args: commandArgs,
        options: {
          "data-dir": { type: "string" },
        },
        strict: false,
      });

      await start({
        dataDir: values["data-dir"] as string | undefined,
      });
      break;
    }

    // ── Install desktop app ────────────────────────────────────────
    case "install":
    case "desktop": { // backward compat
      // Check if already installed — just launch
      const installedPath = findInstalledApp();
      if (installedPath) {
        success(`Deus is installed at ${c.dim(installedPath)}`);
        blank();
        launchDesktop(installedPath);
        success("Launching Deus...");
        blank();
        return;
      }

      const { values } = parseArgs({
        args: commandArgs,
        options: {
          version: { type: "string", default: "latest" },
        },
        strict: false,
      });

      await installDesktop({ version: values.version as string });
      break;
    }

    // ── Generate pairing code ──────────────────────────────────────
    case "pair": {
      await pair();
      break;
    }

    // ── Auth setup ─────────────────────────────────────────────────
    case "login": {
      blank();
      await runAuthSetup({ force: true });
      blank();
      break;
    }

    // ── Server status ──────────────────────────────────────────────
    case "status": {
      await showStatus();
      break;
    }

    default:
      error(`Unknown command: ${c.bold(resolvedCommand)}`);
      blank();
      hint(`Run ${c.cyan("deus --help")} to see available commands.`);
      blank();
      process.exit(1);
  }
}

/**
 * Auto-detect the best mode based on environment.
 *
 * Desktop machine with app installed → launch the desktop app
 * Desktop machine without app → install the desktop app
 * Server/SSH/Docker → start headless server
 */
function autoDetect(): "start" | "install" {
  if (!hasDisplay()) {
    info("No display detected " + c.dim("— starting in server mode"));
    blank();
    return "start";
  }

  // Desktop machine — desktop app is the primary experience
  const installedPath = findInstalledApp();
  if (installedPath) {
    return "install"; // will detect installed and launch
  }

  info("Desktop environment detected " + c.dim("— installing Deus app"));
  blank();
  return "install";
}

main().catch((err) => {
  blank();
  error(`${err.message || err}`);
  blank();
  process.exit(1);
});
