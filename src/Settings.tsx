import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import './Settings.css';
import { API_CONFIG } from './config/api.config';
import type {
  Settings,
  MCPServer,
  Command,
  Agent,
  Hook,
  SettingsSection,
} from './types';

const API_BASE = API_CONFIG.BASE_URL.replace('/api', ''); // Settings uses root URL

export function Settings() {
  const navigate = useNavigate();
  const [activeSection, setActiveSection] = useState<SettingsSection>('general');
  const [settings, setSettings] = useState<Settings>({});
  const [mcpServers, setMcpServers] = useState<MCPServer[]>([]);
  const [commands, setCommands] = useState<Command[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [hooks, setHooks] = useState<Hook>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Load settings from API
  useEffect(() => {
    loadSettings();
    loadFileBasedConfigs();
  }, []);

  async function loadSettings() {
    try {
      const response = await fetch(`${API_BASE}/api/settings`);
      const data = await response.json();
      setSettings(data);
      setLoading(false);
    } catch (error) {
      console.error('Failed to load settings:', error);
      setLoading(false);
    }
  }

  async function loadFileBasedConfigs() {
    try {
      // Load MCP servers
      const mcpResponse = await fetch(`${API_BASE}/api/config/mcp-servers`);
      const mcpData = await mcpResponse.json();
      setMcpServers(mcpData);

      // Load commands
      const commandsResponse = await fetch(`${API_BASE}/api/config/commands`);
      const commandsData = await commandsResponse.json();
      setCommands(commandsData);

      // Load agents
      const agentsResponse = await fetch(`${API_BASE}/api/config/agents`);
      const agentsData = await agentsResponse.json();
      setAgents(agentsData);

      // Load hooks
      const hooksResponse = await fetch(`${API_BASE}/api/config/hooks`);
      const hooksData = await hooksResponse.json();
      setHooks(hooksData);
    } catch (error) {
      console.error('Failed to load file-based configs:', error);
    }
  }

  async function saveSetting(key: string, value: any) {
    setSaving(true);
    try {
      await fetch(`${API_BASE}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value })
      });
      setSettings(prev => ({ ...prev, [key]: value }));
    } catch (error) {
      console.error('Failed to save setting:', error);
      alert('Failed to save setting');
    } finally {
      setSaving(false);
    }
  }

  function renderNavigation() {
    const sections: { id: SettingsSection; label: string; icon: string }[] = [
      { id: 'general', label: 'General', icon: '⚙️' },
      { id: 'account', label: 'Account', icon: '👤' },
      { id: 'terminal', label: 'Terminal', icon: '💻' },
      { id: 'mcp', label: 'MCP', icon: '🔌' },
      { id: 'commands', label: 'Commands', icon: '📝' },
      { id: 'agents', label: 'Agents', icon: '🤖' },
      { id: 'memory', label: 'Memory', icon: '🧠' },
      { id: 'hooks', label: 'Hooks', icon: '🪝' },
      { id: 'provider', label: 'Provider', icon: '🌐' },
      { id: 'experimental', label: 'Experimental', icon: '🧪' },
    ];

    return (
      <nav className="settings-nav">
        {sections.map(section => (
          <button
            key={section.id}
            className={`settings-nav-item ${activeSection === section.id ? 'active' : ''}`}
            onClick={() => setActiveSection(section.id)}
          >
            <span className="settings-nav-icon">{section.icon}</span>
            <span className="settings-nav-label">{section.label}</span>
          </button>
        ))}

        <div className="settings-nav-divider" />

        <a href="https://docs.claude.com/en/docs/claude-code" target="_blank" rel="noopener noreferrer" className="settings-nav-link">
          📖 Documentation
        </a>
        <a href="https://github.com/anthropics/claude-code/releases" target="_blank" rel="noopener noreferrer" className="settings-nav-link">
          📋 Changelog
        </a>
      </nav>
    );
  }

  function renderGeneral() {
    return (
      <div className="settings-section">
        <h2>General Settings</h2>

        <div className="setting-group">
          <label className="setting-label">
            <input
              type="checkbox"
              checked={settings.notifications_enabled ?? true}
              onChange={(e) => saveSetting('notifications_enabled', e.target.checked)}
            />
            Enable notifications
          </label>
          <p className="setting-description">Show desktop notifications for important events</p>
        </div>

        <div className="setting-group">
          <label className="setting-label">
            <input
              type="checkbox"
              checked={settings.sound_effects_enabled ?? true}
              onChange={(e) => saveSetting('sound_effects_enabled', e.target.checked)}
            />
            Enable sound effects
          </label>
          <p className="setting-description">Play sounds for actions and notifications</p>
        </div>

        <div className="setting-group">
          <label className="setting-label">Sound type</label>
          <select
            value={settings.sound_type ?? 'choo-choo'}
            onChange={(e) => saveSetting('sound_type', e.target.value)}
            className="setting-input"
          >
            <option value="choo-choo">Choo Choo</option>
            <option value="beep">Beep</option>
            <option value="chime">Chime</option>
          </select>
        </div>

        <div className="setting-group">
          <label className="setting-label">Diff view mode</label>
          <select
            value={settings.diff_view_mode ?? 'unified'}
            onChange={(e) => saveSetting('diff_view_mode', e.target.value)}
            className="setting-input"
          >
            <option value="unified">Unified</option>
            <option value="split">Split</option>
          </select>
          <p className="setting-description">How to display code diffs</p>
        </div>
      </div>
    );
  }

  function renderAccount() {
    return (
      <div className="settings-section">
        <h2>Account Settings</h2>

        <div className="setting-group">
          <label className="setting-label">Name</label>
          <input
            type="text"
            value={settings.user_name ?? ''}
            onChange={(e) => saveSetting('user_name', e.target.value)}
            className="setting-input"
            placeholder="Your name"
          />
        </div>

        <div className="setting-group">
          <label className="setting-label">Email</label>
          <input
            type="email"
            value={settings.user_email ?? ''}
            onChange={(e) => saveSetting('user_email', e.target.value)}
            className="setting-input"
            placeholder="your@email.com"
          />
        </div>

        <div className="setting-group">
          <label className="setting-label">GitHub Username</label>
          <input
            type="text"
            value={settings.user_github_username ?? ''}
            onChange={(e) => saveSetting('user_github_username', e.target.value)}
            className="setting-input"
            placeholder="github-username"
          />
        </div>

        <div className="setting-group">
          <label className="setting-label">Anthropic API Key</label>
          <input
            type="password"
            value={settings.anthropic_api_key ?? ''}
            onChange={(e) => saveSetting('anthropic_api_key', e.target.value)}
            className="setting-input"
            placeholder="sk-ant-api03-..."
          />
          <p className="setting-description">Your Anthropic API key for Claude models</p>
        </div>
      </div>
    );
  }

  function renderTerminal() {
    return (
      <div className="settings-section">
        <h2>Terminal Settings</h2>

        <div className="setting-group">
          <label className="setting-label">Font size</label>
          <input
            type="number"
            min="8"
            max="24"
            value={settings.terminal_font_size ?? 12}
            onChange={(e) => saveSetting('terminal_font_size', parseInt(e.target.value))}
            className="setting-input"
          />
          <p className="setting-description">Terminal font size in pixels</p>
        </div>

        <div className="setting-group">
          <label className="setting-label">Default editor</label>
          <select
            value={settings.default_open_in ?? 'cursor'}
            onChange={(e) => saveSetting('default_open_in', e.target.value)}
            className="setting-input"
          >
            <option value="cursor">Cursor</option>
            <option value="vscode">VS Code</option>
            <option value="sublime">Sublime Text</option>
            <option value="vim">Vim</option>
          </select>
          <p className="setting-description">Which editor to open files in</p>
        </div>
      </div>
    );
  }

  function renderMCP() {
    return (
      <div className="settings-section">
        <h2>MCP Servers</h2>
        <p className="section-description">
          Configure Model Context Protocol servers to extend Claude's capabilities
        </p>

        <div className="mcp-servers-list">
          {mcpServers.length === 0 ? (
            <div className="empty-state">
              <p>No MCP servers configured</p>
              <p className="setting-description">MCP servers are configured in <code>~/.claude/plugins/config.json</code></p>
            </div>
          ) : (
            mcpServers.map((server, index) => (
              <div key={index} className="mcp-server-item">
                <div className="mcp-server-header">
                  <h3>{server.name}</h3>
                </div>
                <div className="mcp-server-details">
                  <p><strong>Command:</strong> <code>{server.command}</code></p>
                  {server.args && server.args.length > 0 && (
                    <p><strong>Args:</strong> <code>{server.args.join(' ')}</code></p>
                  )}
                  {server.env && Object.keys(server.env).length > 0 && (
                    <p><strong>Environment:</strong> {Object.keys(server.env).length} variables</p>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="setting-help">
          <p>📖 Learn more about <a href="https://modelcontextprotocol.io" target="_blank" rel="noopener noreferrer">Model Context Protocol</a></p>
          <p>Edit <code>~/.claude/plugins/config.json</code> to configure MCP servers</p>
        </div>
      </div>
    );
  }

  function renderCommands() {
    return (
      <div className="settings-section">
        <h2>Custom Commands</h2>
        <p className="section-description">
          Define custom slash commands for frequently used prompts
        </p>

        <div className="commands-list">
          {commands.length === 0 ? (
            <div className="empty-state">
              <p>No custom commands defined</p>
              <p className="setting-description">Create <code>.md</code> files in <code>~/.claude/commands/</code> to define commands</p>
            </div>
          ) : (
            commands.map((cmd, index) => (
              <div key={index} className="command-item">
                <h3>/{cmd.name}</h3>
                <p>{cmd.description}</p>
                <pre>{cmd.content.substring(0, 200)}{cmd.content.length > 200 ? '...' : ''}</pre>
              </div>
            ))
          )}
        </div>

        <div className="setting-help">
          <p>Commands are stored as <code>.md</code> files in <code>~/.claude/commands/</code></p>
          <p>Each file becomes a <code>/{'{'}filename{'}'}</code> slash command</p>
        </div>
      </div>
    );
  }

  function renderAgents() {
    return (
      <div className="settings-section">
        <h2>Agent Configuration</h2>
        <p className="section-description">
          Configure specialized agents with specific tool access
        </p>

        <div className="agents-list">
          {agents.length === 0 ? (
            <div className="empty-state">
              <p>Using default agents</p>
              <p className="setting-description">Create <code>.json</code> files in <code>~/.claude/agents/</code> to define custom agents</p>
            </div>
          ) : (
            agents.map((agent, index) => (
              <div key={index} className="agent-item">
                <div className="agent-header">
                  <h3>{agent.name}</h3>
                </div>
                <p>{agent.description}</p>
                <div className="agent-tools">
                  {agent.tools && agent.tools.map((tool, i) => (
                    <span key={i} className="tool-badge">{tool}</span>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="setting-help">
          <p>Agents are stored as <code>.json</code> files in <code>~/.claude/agents/</code></p>
        </div>
      </div>
    );
  }

  function renderMemory() {
    return (
      <div className="settings-section">
        <h2>Memory Settings</h2>
        <p className="section-description">
          Configure how Claude remembers context across conversations
        </p>

        <div className="setting-group">
          <label className="setting-label">
            <input type="checkbox" defaultChecked />
            Enable conversation memory
          </label>
          <p className="setting-description">Allow Claude to remember previous conversations</p>
        </div>

        <div className="setting-group">
          <label className="setting-label">Memory retention</label>
          <select className="setting-input">
            <option value="session">Current session only</option>
            <option value="day">24 hours</option>
            <option value="week">7 days</option>
            <option value="forever">Forever</option>
          </select>
        </div>

        <div className="setting-group">
          <button className="btn-secondary">Clear All Memory</button>
          <p className="setting-description">Remove all stored conversation context</p>
        </div>
      </div>
    );
  }

  function renderHooks() {
    const hookEntries = Object.entries(hooks);

    return (
      <div className="settings-section">
        <h2>Hooks Configuration</h2>
        <p className="section-description">
          Run custom commands in response to events
        </p>

        <div className="hooks-list">
          {hookEntries.length === 0 ? (
            <div className="empty-state">
              <p>No hooks configured</p>
              <p className="setting-description">Configure hooks in <code>~/.claude/settings.json</code> under the <code>hooks</code> key</p>
            </div>
          ) : (
            hookEntries.map(([event, command], index) => (
              <div key={index} className="hook-item">
                <div className="hook-header">
                  <h3>{event}</h3>
                </div>
                <code>{command}</code>
              </div>
            ))
          )}
        </div>

        <div className="setting-help">
          <p>Hooks are configured in <code>~/.claude/settings.json</code></p>
          <p>Available events: <code>tool-use</code>, <code>message-sent</code>, <code>session-start</code></p>
        </div>
      </div>
    );
  }

  function renderProvider() {
    return (
      <div className="settings-section">
        <h2>Provider Settings</h2>
        <p className="section-description">
          Configure the AI model provider and model selection
        </p>

        <div className="setting-group">
          <label className="setting-label">Provider</label>
          <select
            value={settings.claude_provider ?? 'anthropic'}
            onChange={(e) => saveSetting('claude_provider', e.target.value)}
            className="setting-input"
          >
            <option value="anthropic">Anthropic (Official)</option>
            <option value="custom">Custom Endpoint</option>
            <option value="bedrock">AWS Bedrock</option>
            <option value="vertex">Google Vertex AI</option>
          </select>
        </div>

        <div className="setting-group">
          <label className="setting-label">Default Model</label>
          <select
            value={settings.claude_model ?? 'sonnet'}
            onChange={(e) => saveSetting('claude_model', e.target.value)}
            className="setting-input"
          >
            <option value="sonnet">Claude 3.5 Sonnet (Recommended)</option>
            <option value="opus">Claude 3 Opus</option>
            <option value="haiku">Claude 3.5 Haiku</option>
          </select>
          <p className="setting-description">Default model for new conversations</p>
        </div>

        {settings.claude_provider === 'custom' && (
          <div className="setting-group">
            <label className="setting-label">Custom Endpoint URL</label>
            <input
              type="url"
              className="setting-input"
              placeholder="https://api.example.com/v1"
            />
          </div>
        )}
      </div>
    );
  }

  function renderExperimental() {
    return (
      <div className="settings-section">
        <h2>Experimental Features</h2>
        <p className="section-description">
          Try out new features that are still in development
        </p>

        <div className="setting-group">
          <label className="setting-label">
            <input
              type="checkbox"
              checked={settings.right_panel_visible ?? true}
              onChange={(e) => saveSetting('right_panel_visible', e.target.checked)}
            />
            Show right panel
          </label>
          <p className="setting-description">Display additional information panel</p>
        </div>

        <div className="setting-group">
          <label className="setting-label">
            <input
              type="checkbox"
              checked={settings.using_split_view ?? false}
              onChange={(e) => saveSetting('using_split_view', e.target.checked)}
            />
            Use split view
          </label>
          <p className="setting-description">Show code and chat side by side</p>
        </div>

        <div className="warning-box">
          ⚠️ Experimental features may be unstable and could change at any time
        </div>
      </div>
    );
  }

  function renderContent() {
    if (loading) {
      return <div className="settings-loading">Loading settings...</div>;
    }

    switch (activeSection) {
      case 'general': return renderGeneral();
      case 'account': return renderAccount();
      case 'terminal': return renderTerminal();
      case 'mcp': return renderMCP();
      case 'commands': return renderCommands();
      case 'agents': return renderAgents();
      case 'memory': return renderMemory();
      case 'hooks': return renderHooks();
      case 'provider': return renderProvider();
      case 'experimental': return renderExperimental();
      default: return null;
    }
  }

  return (
    <div className="settings-container">
      <div className="settings-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button
            onClick={() => navigate('/')}
            style={{
              background: 'none',
              border: 'none',
              fontSize: '24px',
              cursor: 'pointer',
              padding: '4px',
              display: 'flex',
              alignItems: 'center',
              borderRadius: '4px',
              transition: 'background 0.2s'
            }}
            onMouseEnter={(e) => e.currentTarget.style.background = '#f3f4f6'}
            onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
            title="Back to Dashboard"
          >
            ←
          </button>
          <h1>Settings</h1>
        </div>
        {saving && <span className="saving-indicator">Saving...</span>}
      </div>

      <div className="settings-body">
        {renderNavigation()}
        <div className="settings-content">
          {renderContent()}
        </div>
      </div>
    </div>
  );
}
