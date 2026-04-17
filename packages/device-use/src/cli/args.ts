import type { GlobalFlags } from "../engine/types.js";

type ParsedFlagValue = string | boolean;
type ParsedFlags = Record<string, ParsedFlagValue>;

export interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: ParsedFlags;
  globalFlags: GlobalFlags;
}

// Flags that never take a value — always boolean toggles
const BOOLEAN_FLAGS = new Set([
  "json",
  "verbose",
  "v",
  "noColor",
  "i",
  "interactive",
  "flat",
  "submit",
  "booted",
  "all",
  "dryRun",
  "base64",
  "gone",
  "diff",
  "annotate",
  "relaunch",
  "exact",
  "contains",
  "user",
  "system",
  "hidden",
  "accept",
  "help",
  "h",
  "version",
]);

const GLOBAL_FLAG_KEYS = new Set([
  "json",
  "verbose",
  "v",
  "noColor",
  "simulator",
  "udid",
  "timeout",
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  let command = "";
  const positionals: string[] = [];
  const flags: ParsedFlags = {};

  const globalFlags: GlobalFlags = {
    json: false,
    verbose: false,
    noColor: false,
  };

  let i = 0;

  while (i < args.length && !command) {
    const arg = args[i]!;
    if (arg.startsWith("-")) {
      i = consumeFlag(args, i, flags, globalFlags, { promoteGlobals: true });
    } else {
      command = arg;
      i++;
    }
  }

  while (i < args.length) {
    const arg = args[i]!;
    if (arg.startsWith("-")) {
      i = consumeFlag(args, i, flags, globalFlags, { promoteGlobals: false });
    } else {
      positionals.push(arg);
      i++;
    }
  }

  if (!process.stdout.isTTY) {
    globalFlags.json = true;
  }
  if (process.env["NO_COLOR"]) {
    globalFlags.noColor = true;
  }

  return { command, positionals, flags, globalFlags };
}

export function finalizeArgsForCommand(
  parsed: ParsedArgs,
  localFlagKeys: Iterable<string> = []
): ParsedArgs {
  const flags: ParsedFlags = {};
  const globalFlags: GlobalFlags = { ...parsed.globalFlags };
  const ownedKeys = new Set(localFlagKeys);

  for (const [key, value] of Object.entries(parsed.flags)) {
    if (!ownedKeys.has(key) && GLOBAL_FLAG_KEYS.has(key)) {
      applyGlobalFlag(key, value, globalFlags);
      continue;
    }
    flags[key] = value;
  }

  return { ...parsed, flags, globalFlags };
}

function consumeFlag(
  args: string[],
  index: number,
  flags: ParsedFlags,
  globalFlags: GlobalFlags,
  options: { promoteGlobals: boolean }
): number {
  const raw = args[index]!;

  if (raw.includes("=")) {
    const eqIndex = raw.indexOf("=");
    const key = normalizeKey(raw.slice(0, eqIndex));
    const value = raw.slice(eqIndex + 1);
    applyFlag(key, value, flags, globalFlags, options);
    return index + 1;
  }

  const key = normalizeKey(raw);

  if (BOOLEAN_FLAGS.has(key)) {
    applyFlag(key, true, flags, globalFlags, options);
    return index + 1;
  }

  const next = args[index + 1];
  if (next !== undefined && !next.startsWith("-")) {
    applyFlag(key, next, flags, globalFlags, options);
    return index + 2;
  }

  applyFlag(key, true, flags, globalFlags, options);
  return index + 1;
}

function normalizeKey(raw: string): string {
  return raw.replace(/^-+/, "").replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function applyFlag(
  key: string,
  value: ParsedFlagValue,
  flags: ParsedFlags,
  globalFlags: GlobalFlags,
  options: { promoteGlobals: boolean }
): void {
  if (options.promoteGlobals && GLOBAL_FLAG_KEYS.has(key)) {
    applyGlobalFlag(key, value, globalFlags);
    return;
  }
  flags[key] = value;
}

function applyGlobalFlag(key: string, value: ParsedFlagValue, globalFlags: GlobalFlags): void {
  switch (key) {
    case "json":
      globalFlags.json = true;
      break;
    case "verbose":
    case "v":
      globalFlags.verbose = true;
      break;
    case "noColor":
      globalFlags.noColor = true;
      break;
    case "simulator":
    case "udid":
      globalFlags.simulator = String(value);
      break;
    case "timeout":
      globalFlags.timeoutMs = Number(value) * 1000;
      break;
  }
}
