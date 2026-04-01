/**
 * Auth setup — detects Claude Code CLI and configures AI agent authentication.
 *
 * Detection order:
 * 1. ANTHROPIC_API_KEY already in environment → done
 * 2. Claude Code CLI installed + authenticated → done
 * 3. Interactive prompt: install CLI / enter API key / skip
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { select, input } from "./prompt.js";
import { loadConfig, saveConfig } from "./config.js";
import {
  spinner as createSpinner,
  c,
  sym,
  blank,
  success,
  error,
  warn,
  hint,
} from "./ui.js";

// ── Types ────────────────────────────────────────────────────────────

export interface AuthResult {
  method: "claude_cli" | "api_key" | "env" | "skipped";
  apiKey?: string;
}

interface ClaudeCliInfo {
  installed: boolean;
  path?: string;
  version?: string;
}

// ── Claude CLI Discovery ─────────────────────────────────────────────

// Candidate paths to check (mirrors agent-server/agents/claude/claude-discovery.ts)
function getClaudeCliCandidates(): string[] {
  const candidates: string[] = [];

  // Env var override
  if (process.env.CLAUDE_CLI_PATH) {
    candidates.push(process.env.CLAUDE_CLI_PATH);
  }

  const os = platform();
  if (os === "darwin") {
    candidates.push(
      "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js",
      "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js",
      join(homedir(), ".npm/lib/node_modules/@anthropic-ai/claude-code/cli.js"),
    );
  } else if (os === "linux") {
    candidates.push(
      "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js",
      "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js",
      join(homedir(), ".npm/lib/node_modules/@anthropic-ai/claude-code/cli.js"),
    );
  }

  return candidates;
}

export function detectClaudeCli(): ClaudeCliInfo {
  // Check candidate paths
  for (const candidate of getClaudeCliCandidates()) {
    if (existsSync(candidate)) {
      try {
        const version = execSync(`node "${candidate}" --version`, {
          encoding: "utf-8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        return { installed: true, path: candidate, version };
      } catch {
        // File exists but doesn't run — skip
      }
    }
  }

  // Try PATH discovery
  try {
    const shell = process.env.SHELL || "/bin/sh";
    const claudePath = execSync(`${shell} -lc "command -v claude"`, {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (claudePath) {
      try {
        const version = execSync(`"${claudePath}" --version`, {
          encoding: "utf-8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        return { installed: true, path: claudePath, version };
      } catch {
        return { installed: true, path: claudePath };
      }
    }
  } catch {
    // Not in PATH
  }

  return { installed: false };
}

/** Check if Claude CLI has stored credentials */
function isClaudeAuthenticated(): boolean {
  // Claude Code stores credentials in ~/.claude/
  const credPaths = [
    join(homedir(), ".claude", ".credentials.json"),
    join(homedir(), ".claude", "credentials.json"),
  ];

  for (const p of credPaths) {
    if (existsSync(p)) return true;
  }

  return false;
}

// ── Auth Setup Flow ──────────────────────────────────────────────────

export async function runAuthSetup(opts?: { force?: boolean }): Promise<AuthResult> {
  const config = loadConfig();

  // If not forced and already configured, return saved config
  if (!opts?.force && config.auth_method) {
    return {
      method: config.auth_method as AuthResult["method"],
      apiKey: config.anthropic_api_key,
    };
  }

  // ── Check environment variable first ─────────────────────────────
  if (process.env.ANTHROPIC_API_KEY) {
    success("ANTHROPIC_API_KEY detected in environment");
    blank();
    const result: AuthResult = { method: "env" };
    config.auth_method = "env";
    saveConfig(config);
    return result;
  }

  // ── Detect Claude CLI ────────────────────────────────────────────
  const cli = detectClaudeCli();

  if (cli.installed && isClaudeAuthenticated()) {
    // Best case: CLI installed and authenticated
    success(`Claude Code CLI found${cli.version ? ` (${c.dim(cli.version)})` : ""}`);
    success("Authenticated");
    blank();
    hint("Ready to go! No additional setup needed.");
    blank();

    const result: AuthResult = { method: "claude_cli" };
    config.auth_method = "claude_cli";
    saveConfig(config);
    return result;
  }

  if (cli.installed) {
    // CLI installed but not authenticated
    success(`Claude Code CLI found${cli.version ? ` (${c.dim(cli.version)})` : ""}`);
    warn("Not authenticated");
    blank();

    const choice = await select({
      message: "How would you like to authenticate?",
      options: [
        { label: "Run claude login", value: "login" as const, hint: "opens browser to sign in" },
        { label: "Enter API key manually", value: "api_key" as const },
        { label: "Skip for now", value: "skip" as const },
      ],
    });

    if (choice === "login") {
      return await runClaudeLogin(cli.path!);
    }
    if (choice === "api_key") {
      return await promptForApiKey();
    }
    return skipAuth();
  }

  // CLI not installed
  error("Claude Code CLI not found");
  blank();
  hint("Deus uses Claude Code to power AI agents.");
  blank();

  const choice = await select({
    message: "How would you like to set it up?",
    options: [
      { label: "Install Claude Code", value: "install" as const, hint: "npm install -g @anthropic-ai/claude-code" },
      { label: "Enter API key manually", value: "api_key" as const },
      { label: "Skip for now", value: "skip" as const },
    ],
  });

  if (choice === "install") {
    return await installAndLogin();
  }
  if (choice === "api_key") {
    return await promptForApiKey();
  }
  return skipAuth();
}

// ── Sub-flows ────────────────────────────────────────────────────────

async function runClaudeLogin(cliPath: string): Promise<AuthResult> {
  blank();
  hint("Opening browser for authentication...");
  blank();

  // Run claude login interactively — inherit stdio so user can interact
  const result = spawnSync(cliPath, ["login"], {
    stdio: "inherit",
    timeout: 120_000,
  });

  if (result.status === 0 && isClaudeAuthenticated()) {
    blank();
    success("Authenticated successfully!");
    blank();

    const config = loadConfig();
    config.auth_method = "claude_cli";
    saveConfig(config);
    return { method: "claude_cli" };
  }

  blank();
  warn("Authentication may not have completed.");
  hint(`You can try again later with ${c.cyan("deus login")}`);
  blank();
  return skipAuth();
}

async function installAndLogin(): Promise<AuthResult> {
  blank();
  const s = createSpinner("Installing Claude Code CLI...");

  const result = spawnSync("npm", ["install", "-g", "@anthropic-ai/claude-code"], {
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 120_000,
  });

  if (result.status !== 0) {
    s.fail("Installation failed");
    blank();
    hint("Try installing manually:");
    console.log(`    ${c.cyan("npm install -g @anthropic-ai/claude-code")}`);
    blank();
    return skipAuth();
  }

  s.succeed("Claude Code CLI installed");

  // Now detect and run login
  const cli = detectClaudeCli();
  if (cli.installed && cli.path) {
    return await runClaudeLogin(cli.path);
  }

  blank();
  warn("CLI installed but could not be found in PATH.");
  hint("Try opening a new terminal and running:");
  console.log(`    ${c.cyan("claude login")}`);
  blank();
  return skipAuth();
}

async function promptForApiKey(): Promise<AuthResult> {
  blank();
  hint(`Get your key from ${c.cyan(c.underline("console.anthropic.com"))}`);
  blank();

  const key = await input({
    message: "Enter your Anthropic API key:",
    mask: true,
  });

  if (!key || key.trim().length < 10) {
    blank();
    warn("Invalid API key.");
    return skipAuth();
  }

  // Basic validation
  const trimmed = key.trim();
  if (!trimmed.startsWith("sk-ant-")) {
    blank();
    warn("Key doesn't look like an Anthropic API key (should start with sk-ant-)");
    hint("Saving anyway — you can change it later.");
  }

  blank();
  success("API key saved");
  blank();

  const config = loadConfig();
  config.auth_method = "api_key";
  config.anthropic_api_key = trimmed;
  saveConfig(config);

  return { method: "api_key", apiKey: trimmed };
}

function skipAuth(): AuthResult {
  const config = loadConfig();
  config.auth_method = "skipped";
  saveConfig(config);

  hint(`You can configure this later with ${c.cyan("deus login")}`);
  blank();
  return { method: "skipped" };
}
