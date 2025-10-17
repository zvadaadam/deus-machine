/**
 * File-Based Configuration Management Module
 *
 * Manages Claude Code configuration stored in the ~/.claude directory:
 * - MCP Servers: Model Context Protocol server configurations
 * - Commands: Custom slash commands
 * - Agents: Custom agent definitions
 * - Hooks: Event hooks for tool usage
 * - Settings: Application settings
 *
 * All configurations are file-based, matching the OpenDevs app's
 * architecture exactly.
 *
 * @module config
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Base directory for Claude configuration
 * @type {string}
 */
const CLAUDE_DIR = path.join(os.homedir(), '.claude');

/**
 * Path to MCP servers configuration
 * @type {string}
 */
const MCP_CONFIG_PATH = path.join(CLAUDE_DIR, 'plugins', 'config.json');

/**
 * Directory for custom commands
 * @type {string}
 */
const COMMANDS_DIR = path.join(CLAUDE_DIR, 'commands');

/**
 * Directory for custom agents
 * @type {string}
 */
const AGENTS_DIR = path.join(CLAUDE_DIR, 'agents');

/**
 * Path to main settings file
 * @type {string}
 */
const SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json');

/**
 * Path to local settings file (overrides main settings)
 * @type {string}
 */
const SETTINGS_LOCAL_PATH = path.join(CLAUDE_DIR, 'settings.local.json');

/**
 * Ensure all configuration directories exist
 *
 * Creates the ~/.claude directory structure if it doesn't exist.
 * Called during module initialization.
 */
function ensureDirectories() {
  const dirs = [
    CLAUDE_DIR,
    path.dirname(MCP_CONFIG_PATH),
    COMMANDS_DIR,
    AGENTS_DIR
  ];

  dirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`✅ Created directory: ${dir}`);
    }
  });
}

// Initialize directories on module load
ensureDirectories();

/**
 * Get MCP server configurations
 *
 * Reads from ~/.claude/plugins/config.json and returns an array
 * of MCP server configurations.
 *
 * @returns {Array<Object>} Array of MCP server configs with { name, command, args, env }
 */
function getMcpServers() {
  try {
    if (!fs.existsSync(MCP_CONFIG_PATH)) {
      return [];
    }

    const config = JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, 'utf8'));
    const servers = [];

    if (config.mcpServers) {
      for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
        servers.push({
          name,
          command: serverConfig.command,
          args: serverConfig.args || [],
          env: serverConfig.env || {}
        });
      }
    }

    return servers;
  } catch (error) {
    console.error('Error reading MCP config:', error);
    return [];
  }
}

/**
 * Save MCP server configurations
 *
 * Writes MCP server configurations to ~/.claude/plugins/config.json
 *
 * @param {Array<Object>} servers - Array of server configs
 * @returns {boolean} True if saved successfully
 */
function saveMcpServers(servers) {
  try {
    const mcpServers = {};
    servers.forEach(server => {
      mcpServers[server.name] = {
        command: server.command,
        args: server.args || [],
        env: server.env || {}
      };
    });

    const config = { mcpServers };
    fs.writeFileSync(MCP_CONFIG_PATH, JSON.stringify(config, null, 2));
    console.log(`✅ MCP servers saved to ${MCP_CONFIG_PATH}`);
    return true;
  } catch (error) {
    console.error('Error saving MCP config:', error);
    return false;
  }
}

/**
 * Get custom commands
 *
 * Reads all .md files from ~/.claude/commands directory and returns
 * an array of command configurations.
 *
 * @returns {Array<Object>} Array of commands with { name, description, content }
 */
function getCommands() {
  try {
    if (!fs.existsSync(COMMANDS_DIR)) {
      return [];
    }

    const files = fs.readdirSync(COMMANDS_DIR).filter(f => f.endsWith('.md'));
    const commands = [];

    files.forEach(file => {
      const filePath = path.join(COMMANDS_DIR, file);
      const content = fs.readFileSync(filePath, 'utf8');
      const name = file.replace('.md', '');

      // Extract description from first line (if it's a heading)
      const firstLine = content.split('\n')[0];
      const description = firstLine.replace(/^#\s*/, '');

      commands.push({
        name,
        description,
        content
      });
    });

    return commands;
  } catch (error) {
    console.error('Error reading commands:', error);
    return [];
  }
}

/**
 * Save a custom command
 *
 * Writes a command to ~/.claude/commands/{name}.md
 *
 * @param {string} name - The command name (without .md extension)
 * @param {string} content - The command content (markdown)
 * @returns {boolean} True if saved successfully
 */
function saveCommand(name, content) {
  try {
    const filePath = path.join(COMMANDS_DIR, `${name}.md`);
    fs.writeFileSync(filePath, content);
    console.log(`✅ Command saved: ${filePath}`);
    return true;
  } catch (error) {
    console.error('Error saving command:', error);
    return false;
  }
}

/**
 * Delete a custom command
 *
 * Removes a command file from ~/.claude/commands/
 *
 * @param {string} name - The command name (without .md extension)
 * @returns {boolean} True if deleted successfully
 */
function deleteCommand(name) {
  try {
    const filePath = path.join(COMMANDS_DIR, `${name}.md`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`✅ Command deleted: ${filePath}`);
      return true;
    }
    return false;
  } catch (error) {
    console.error('Error deleting command:', error);
    return false;
  }
}

/**
 * Get custom agents
 *
 * Reads all .json files from ~/.claude/agents directory and returns
 * an array of agent configurations.
 *
 * @returns {Array<Object>} Array of agents with { id, name, description, tools }
 */
function getAgents() {
  try {
    if (!fs.existsSync(AGENTS_DIR)) {
      return [];
    }

    const files = fs.readdirSync(AGENTS_DIR).filter(f => f.endsWith('.json'));
    const agents = [];

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

/**
 * Save a custom agent
 *
 * Writes an agent configuration to ~/.claude/agents/{id}.json
 *
 * @param {string} id - The agent ID (without .json extension)
 * @param {Object} agentData - The agent configuration object
 * @returns {boolean} True if saved successfully
 */
function saveAgent(id, agentData) {
  try {
    const filePath = path.join(AGENTS_DIR, `${id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(agentData, null, 2));
    console.log(`✅ Agent saved: ${filePath}`);
    return true;
  } catch (error) {
    console.error('Error saving agent:', error);
    return false;
  }
}

/**
 * Delete a custom agent
 *
 * Removes an agent file from ~/.claude/agents/
 *
 * @param {string} id - The agent ID (without .json extension)
 * @returns {boolean} True if deleted successfully
 */
function deleteAgent(id) {
  try {
    const filePath = path.join(AGENTS_DIR, `${id}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`✅ Agent deleted: ${filePath}`);
      return true;
    }
    return false;
  } catch (error) {
    console.error('Error deleting agent:', error);
    return false;
  }
}

/**
 * Get hooks configuration
 *
 * Reads hooks from ~/.claude/settings.json
 *
 * @returns {Object} Hooks configuration object
 */
function getHooks() {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) {
      return {};
    }
    const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    return settings.hooks || {};
  } catch (error) {
    console.error('Error reading hooks:', error);
    return {};
  }
}

/**
 * Save hooks configuration
 *
 * Writes hooks to ~/.claude/settings.json
 *
 * @param {Object} hooks - Hooks configuration object
 * @returns {boolean} True if saved successfully
 */
function saveHooks(hooks) {
  try {
    let settings = {};
    if (fs.existsSync(SETTINGS_PATH)) {
      settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    }
    settings.hooks = hooks;
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
    console.log(`✅ Hooks saved to ${SETTINGS_PATH}`);
    return true;
  } catch (error) {
    console.error('Error saving hooks:', error);
    return false;
  }
}

module.exports = {
  // Directory paths
  CLAUDE_DIR,
  MCP_CONFIG_PATH,
  COMMANDS_DIR,
  AGENTS_DIR,
  SETTINGS_PATH,
  SETTINGS_LOCAL_PATH,

  // Functions
  ensureDirectories,
  getMcpServers,
  saveMcpServers,
  getCommands,
  saveCommand,
  deleteCommand,
  getAgents,
  saveAgent,
  deleteAgent,
  getHooks,
  saveHooks
};
