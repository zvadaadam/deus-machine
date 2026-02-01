import fs from 'fs';
import path from 'path';
import os from 'os';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const MCP_CONFIG_PATH = path.join(CLAUDE_DIR, 'plugins', 'config.json');
const COMMANDS_DIR = path.join(CLAUDE_DIR, 'commands');
const AGENTS_DIR = path.join(CLAUDE_DIR, 'agents');
const SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json');
const SETTINGS_LOCAL_PATH = path.join(CLAUDE_DIR, 'settings.local.json');

function sanitizeName(name: string): string {
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error('Invalid name: must be alphanumeric, hyphens, or underscores only');
  }
  return name;
}

function ensureDirectories(): void {
  const dirs = [CLAUDE_DIR, path.dirname(MCP_CONFIG_PATH), COMMANDS_DIR, AGENTS_DIR];
  dirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

// Initialize directories on module load
ensureDirectories();

export function getMcpServers(): Array<{ name: string; command: string; args: string[]; env: Record<string, string> }> {
  try {
    if (!fs.existsSync(MCP_CONFIG_PATH)) return [];

    const config = JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, 'utf8'));
    const servers: Array<{ name: string; command: string; args: string[]; env: Record<string, string> }> = [];

    if (config.mcpServers) {
      for (const [name, serverConfig] of Object.entries(config.mcpServers) as [string, any][]) {
        servers.push({
          name,
          command: serverConfig.command,
          args: serverConfig.args || [],
          env: serverConfig.env || {},
        });
      }
    }

    return servers;
  } catch (error) {
    console.error('Error reading MCP config:', error);
    return [];
  }
}

export function saveMcpServers(servers: Array<{ name: string; command: string; args?: string[]; env?: Record<string, string> }>): boolean {
  try {
    const mcpServers: Record<string, any> = {};
    servers.forEach(server => {
      mcpServers[server.name] = {
        command: server.command,
        args: server.args || [],
        env: server.env || {},
      };
    });

    fs.writeFileSync(MCP_CONFIG_PATH, JSON.stringify({ mcpServers }, null, 2));
    return true;
  } catch (error) {
    console.error('Error saving MCP config:', error);
    return false;
  }
}

export function getCommands(): Array<{ name: string; description: string; content: string }> {
  try {
    if (!fs.existsSync(COMMANDS_DIR)) return [];

    const files = fs.readdirSync(COMMANDS_DIR).filter(f => f.endsWith('.md'));
    const commands: Array<{ name: string; description: string; content: string }> = [];

    files.forEach(file => {
      const filePath = path.join(COMMANDS_DIR, file);
      const content = fs.readFileSync(filePath, 'utf8');
      const name = file.replace('.md', '');
      const firstLine = content.split('\n')[0];
      const description = firstLine.replace(/^#\s*/, '');
      commands.push({ name, description, content });
    });

    return commands;
  } catch (error) {
    console.error('Error reading commands:', error);
    return [];
  }
}

export function saveCommand(name: string, content: string): boolean {
  try {
    name = sanitizeName(name);
    const filePath = path.join(COMMANDS_DIR, `${name}.md`);
    fs.writeFileSync(filePath, content);
    return true;
  } catch (error) {
    console.error('Error saving command:', error);
    return false;
  }
}

export function deleteCommand(name: string): boolean {
  try {
    name = sanitizeName(name);
    const filePath = path.join(COMMANDS_DIR, `${name}.md`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
    return false;
  } catch (error) {
    console.error('Error deleting command:', error);
    return false;
  }
}

export function getAgents(): Array<{ id: string; name?: string; description?: string; tools?: string[] }> {
  try {
    if (!fs.existsSync(AGENTS_DIR)) return [];

    const files = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.json'));
    const agents: Array<{ id: string; name?: string; description?: string; tools?: string[] }> = [];

    files.forEach(file => {
      const filePath = path.join(AGENTS_DIR, file);
      const content = fs.readFileSync(filePath, 'utf8');
      const agent = JSON.parse(content);
      agent.id = file.replace('.json', '');
      agents.push(agent);
    });

    return agents;
  } catch (error) {
    console.error('Error reading agents:', error);
    return [];
  }
}

export function saveAgent(id: string, agentData: Record<string, any>): boolean {
  try {
    id = sanitizeName(id);
    const filePath = path.join(AGENTS_DIR, `${id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(agentData, null, 2));
    return true;
  } catch (error) {
    console.error('Error saving agent:', error);
    return false;
  }
}

export function deleteAgent(id: string): boolean {
  try {
    id = sanitizeName(id);
    const filePath = path.join(AGENTS_DIR, `${id}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
    return false;
  } catch (error) {
    console.error('Error deleting agent:', error);
    return false;
  }
}

export function getHooks(): Record<string, any> {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) return {};
    const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    return settings.hooks || {};
  } catch (error) {
    console.error('Error reading hooks:', error);
    return {};
  }
}

export function saveHooks(hooks: Record<string, any>): boolean {
  try {
    let settings: Record<string, any> = {};
    if (fs.existsSync(SETTINGS_PATH)) {
      settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    }
    settings.hooks = hooks;
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
    return true;
  } catch (error) {
    console.error('Error saving hooks:', error);
    return false;
  }
}

export {
  CLAUDE_DIR,
  MCP_CONFIG_PATH,
  COMMANDS_DIR,
  AGENTS_DIR,
  SETTINGS_PATH,
  SETTINGS_LOCAL_PATH,
  ensureDirectories,
};
