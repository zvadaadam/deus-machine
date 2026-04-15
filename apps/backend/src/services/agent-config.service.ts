import fs from "fs";
import path from "path";
import os from "os";
import { McpConfigFile, AgentConfigFile, SettingsFile } from "../lib/schemas";
import type {
  SkillItem,
  CommandItem,
  AgentItem,
  McpServerItem,
  HooksMap,
} from "@shared/types/agent-config";

const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const COMMANDS_DIR = path.join(CLAUDE_DIR, "commands");
const AGENTS_DIR = path.join(CLAUDE_DIR, "agents");
const SETTINGS_PATH = path.join(CLAUDE_DIR, "settings.json");

/**
 * Resolve the .claude directory for a given scope.
 * Global: ~/.claude/    Project: {projectPath}/.claude/
 * Validates that projectPath is an absolute path to prevent traversal attacks.
 */
function resolveClaudeDir(projectPath?: string): string {
  if (!projectPath) return CLAUDE_DIR;
  if (!path.isAbsolute(projectPath)) {
    throw new Error("projectPath must be an absolute path");
  }
  return path.join(projectPath, ".claude");
}

function sanitizeName(name: string): string {
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error("Invalid name: must be alphanumeric, hyphens, or underscores only");
  }
  return name;
}

function ensureDirectories(): void {
  const dirs = [CLAUDE_DIR, path.join(CLAUDE_DIR, "plugins"), COMMANDS_DIR, AGENTS_DIR];
  dirs.forEach((dir) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

// Initialize global directories on module load
ensureDirectories();

// ============================================================================
// MCP Servers
// ============================================================================

export function getMcpServers(projectPath?: string): McpServerItem[] {
  const configPath = path.join(resolveClaudeDir(projectPath), "plugins", "config.json");
  if (!fs.existsSync(configPath)) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    console.error("Failed to parse MCP config file as JSON");
    return [];
  }

  const parsed = McpConfigFile.safeParse(raw);
  if (!parsed.success) {
    console.error("Invalid MCP config file:", parsed.error.issues);
    return [];
  }

  return Object.entries(parsed.data.mcpServers).map(([name, entry]) => ({
    name,
    command: entry.command,
    args: entry.args,
    env: entry.env,
  }));
}

export function saveMcpServers(
  servers: Array<{ name: string; command: string; args?: string[]; env?: Record<string, string> }>,
  projectPath?: string
): void {
  const configPath = path.join(resolveClaudeDir(projectPath), "plugins", "config.json");
  const configDir = path.dirname(configPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  // Read existing config to preserve non-mcpServers keys
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      // Corrupted config — start fresh
      console.error("Failed to parse existing MCP config, starting fresh");
    }
  }

  const mcpServers: Record<
    string,
    { command: string; args: string[]; env: Record<string, string> }
  > = {};
  servers.forEach((server) => {
    mcpServers[server.name] = {
      command: server.command,
      args: server.args || [],
      env: server.env || {},
    };
  });

  fs.writeFileSync(configPath, JSON.stringify({ ...existing, mcpServers }, null, 2));
}

// ============================================================================
// Commands
// ============================================================================

export function getCommands(projectPath?: string): CommandItem[] {
  const commandsDir = path.join(resolveClaudeDir(projectPath), "commands");
  if (!fs.existsSync(commandsDir)) return [];

  const files = fs.readdirSync(commandsDir).filter((f) => f.endsWith(".md"));
  const commands: CommandItem[] = [];

  files.forEach((file) => {
    const filePath = path.join(commandsDir, file);
    const content = fs.readFileSync(filePath, "utf8");
    const name = file.replace(".md", "");
    const firstLine = content.split("\n")[0];
    const description = firstLine.replace(/^#\s*/, "");
    commands.push({ name, description, content });
  });

  return commands;
}

export function saveCommand(name: string, content: string, projectPath?: string): void {
  name = sanitizeName(name);
  const commandsDir = path.join(resolveClaudeDir(projectPath), "commands");
  if (!fs.existsSync(commandsDir)) {
    fs.mkdirSync(commandsDir, { recursive: true });
  }
  const filePath = path.join(commandsDir, `${name}.md`);
  fs.writeFileSync(filePath, content);
}

export function deleteCommand(name: string, projectPath?: string): boolean {
  name = sanitizeName(name);
  const filePath = path.join(resolveClaudeDir(projectPath), "commands", `${name}.md`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}

// ============================================================================
// Agents
// ============================================================================

export function getAgents(projectPath?: string): AgentItem[] {
  const agentsDir = path.join(resolveClaudeDir(projectPath), "agents");
  if (!fs.existsSync(agentsDir)) return [];

  const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith(".json"));
  const agents: AgentItem[] = [];

  files.forEach((file) => {
    const filePath = path.join(agentsDir, file);
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const parsed = AgentConfigFile.safeParse(raw);
      if (!parsed.success) {
        console.error(`Invalid agent config ${file}:`, parsed.error.issues);
        return;
      }
      agents.push({ ...parsed.data, id: file.replace(".json", "") });
    } catch {
      // Skip unparseable agent files — they may be hand-edited
      console.error(`Failed to parse agent file: ${file}`);
    }
  });

  return agents;
}

export function saveAgent(
  id: string,
  agentData: { name?: string; description?: string; tools?: string[] },
  projectPath?: string
): void {
  id = sanitizeName(id);
  const agentsDir = path.join(resolveClaudeDir(projectPath), "agents");
  if (!fs.existsSync(agentsDir)) {
    fs.mkdirSync(agentsDir, { recursive: true });
  }
  const filePath = path.join(agentsDir, `${id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(agentData, null, 2));
}

export function deleteAgent(id: string, projectPath?: string): boolean {
  id = sanitizeName(id);
  const filePath = path.join(resolveClaudeDir(projectPath), "agents", `${id}.json`);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}

// ============================================================================
// Hooks
// ============================================================================

export function getHooks(projectPath?: string): HooksMap {
  const settingsPath = path.join(resolveClaudeDir(projectPath), "settings.json");
  if (!fs.existsSync(settingsPath)) return {};

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch {
    console.error("Failed to parse settings.json as JSON");
    return {};
  }

  const parsed = SettingsFile.safeParse(raw);
  if (!parsed.success) {
    console.error("Invalid settings file:", parsed.error.issues);
    return {};
  }
  return parsed.data.hooks as HooksMap;
}

export function saveHooks(hooks: HooksMap, projectPath?: string): void {
  const settingsPath = path.join(resolveClaudeDir(projectPath), "settings.json");
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      // Only use parsed result if it's a plain object — arrays, strings, etc. are not valid settings
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        settings = parsed as Record<string, unknown>;
      } else {
        console.error("settings.json is not a valid object, starting with empty settings");
      }
    } catch {
      // Corrupted settings.json — start fresh to avoid crashing the write
      console.error("Failed to parse settings.json, starting with empty settings");
    }
  }
  settings.hooks = hooks;
  const settingsDir = path.dirname(settingsPath);
  if (!fs.existsSync(settingsDir)) {
    fs.mkdirSync(settingsDir, { recursive: true });
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

// ============================================================================
// Skills
// ============================================================================

/**
 * Parse simple YAML frontmatter from a SKILL.md file.
 * Returns key-value pairs from the --- delimited block at the top.
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const frontmatter: Record<string, string> = {};
  match[1].split("\n").forEach((line) => {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line
        .slice(colonIdx + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      frontmatter[key] = value;
    }
  });

  return { frontmatter, body: match[2] };
}

export function getSkills(projectPath?: string): SkillItem[] {
  const skillsDir = path.join(resolveClaudeDir(projectPath), "skills");
  if (!fs.existsSync(skillsDir)) return [];

  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  const skills: SkillItem[] = [];

  entries.forEach((entry) => {
    const skillMdPath = path.join(skillsDir, entry.name, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) return;

    try {
      const content = fs.readFileSync(skillMdPath, "utf8");
      const { frontmatter } = parseFrontmatter(content);
      // Use directory name as canonical identity — frontmatter.name is display-only
      skills.push({
        name: entry.name,
        description: frontmatter.description || frontmatter.name || "",
        content,
      });
    } catch {
      // Skip unreadable skill directories
      console.error(`Failed to read skill: ${entry.name}`);
    }
  });

  return skills;
}

export function saveSkill(name: string, content: string, projectPath?: string): void {
  name = sanitizeName(name);
  const skillDir = path.join(resolveClaudeDir(projectPath), "skills", name);
  if (!fs.existsSync(skillDir)) {
    fs.mkdirSync(skillDir, { recursive: true });
  }
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), content);
}

export function deleteSkill(name: string, projectPath?: string): boolean {
  name = sanitizeName(name);
  const skillDir = path.join(resolveClaudeDir(projectPath), "skills", name);
  if (fs.existsSync(skillDir)) {
    fs.rmSync(skillDir, { recursive: true });
    return true;
  }
  return false;
}

// Test-only exports — constants used by backend tests to construct expected paths
export { CLAUDE_DIR, COMMANDS_DIR, AGENTS_DIR, SETTINGS_PATH };
