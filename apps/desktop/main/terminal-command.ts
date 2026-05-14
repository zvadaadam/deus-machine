import { resolveBundledCliPath } from "../../../shared/lib/cli-path";

const TERMINAL_TOKEN_PATTERN = /^[a-zA-Z0-9_-]+$/;
const PACKAGED_TERMINAL_TOOLS = new Set(["claude", "codex"]);

function isPackagedRuntime(): boolean {
  return process.env.DEUS_PACKAGED === "1" || process.env.DEUS_RUNTIME === "1";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function toAppleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function resolveTerminalCliCommand(command: string): string | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.some((token) => !TERMINAL_TOKEN_PATTERN.test(token))) {
    return null;
  }

  const [tool, ...args] = tokens;
  if (isPackagedRuntime() && PACKAGED_TERMINAL_TOOLS.has(tool)) {
    const bundledPath = resolveBundledCliPath(tool);
    if (!bundledPath) return null;
    return [shellQuote(bundledPath), ...args.map(shellQuote)].join(" ");
  }

  return tokens.map(shellQuote).join(" ");
}
