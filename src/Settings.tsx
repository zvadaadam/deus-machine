import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import './Settings.css';
import { getBaseURL } from './config/api.config';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { ArrowLeft } from 'lucide-react';
import type {
  Settings,
  MCPServer,
  Command,
  Agent,
  Hook,
  SettingsSection,
} from './types';

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
      const response = await fetch(`${await getBaseURL()}/api/settings`);
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
      const mcpResponse = await fetch(`${await getBaseURL()}/api/config/mcp-servers`);
      const mcpData = await mcpResponse.json();
      setMcpServers(mcpData);

      // Load commands
      const commandsResponse = await fetch(`${await getBaseURL()}/api/config/commands`);
      const commandsData = await commandsResponse.json();
      setCommands(commandsData);

      // Load agents
      const agentsResponse = await fetch(`${await getBaseURL()}/api/config/agents`);
      const agentsData = await agentsResponse.json();
      setAgents(agentsData);

      // Load hooks
      const hooksResponse = await fetch(`${await getBaseURL()}/api/config/hooks`);
      const hooksData = await hooksResponse.json();
      setHooks(hooksData);
    } catch (error) {
      console.error('Failed to load file-based configs:', error);
    }
  }

  async function saveSetting(key: string, value: any) {
    setSaving(true);
    try {
      await fetch(`${await getBaseURL()}/api/settings`, {
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
      <nav className="settings-nav flex flex-col gap-1 p-2">
        {sections.map(section => (
          <Button
            key={section.id}
            variant={activeSection === section.id ? "default" : "ghost"}
            className="w-full justify-start gap-3"
            onClick={() => setActiveSection(section.id)}
          >
            <span className="text-lg">{section.icon}</span>
            <span>{section.label}</span>
          </Button>
        ))}

        <Separator className="my-2" />

        <Button
          variant="ghost"
          className="w-full justify-start gap-3"
          asChild
        >
          <a href="https://docs.claude.com/en/docs/claude-code" target="_blank" rel="noopener noreferrer">
            <span className="text-lg">📖</span>
            <span>Documentation</span>
          </a>
        </Button>
        <Button
          variant="ghost"
          className="w-full justify-start gap-3"
          asChild
        >
          <a href="https://github.com/anthropics/claude-code/releases" target="_blank" rel="noopener noreferrer">
            <span className="text-lg">📋</span>
            <span>Changelog</span>
          </a>
        </Button>
      </nav>
    );
  }

  function renderGeneral() {
    return (
      <div className="settings-section space-y-6">
        <h2 className="text-2xl font-semibold">General Settings</h2>

        <div className="space-y-4">
          <div className="flex items-center space-x-3">
            <Checkbox
              id="notifications"
              checked={settings.notifications_enabled ?? true}
              onCheckedChange={(checked) => saveSetting('notifications_enabled', checked)}
            />
            <div className="flex-1">
              <Label htmlFor="notifications" className="text-base font-medium cursor-pointer">
                Enable notifications
              </Label>
              <p className="text-sm text-muted-foreground">Show desktop notifications for important events</p>
            </div>
          </div>

          <div className="flex items-center space-x-3">
            <Checkbox
              id="sound-effects"
              checked={settings.sound_effects_enabled ?? true}
              onCheckedChange={(checked) => saveSetting('sound_effects_enabled', checked)}
            />
            <div className="flex-1">
              <Label htmlFor="sound-effects" className="text-base font-medium cursor-pointer">
                Enable sound effects
              </Label>
              <p className="text-sm text-muted-foreground">Play sounds for actions and notifications</p>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="sound-type">Sound type</Label>
            <Select
              value={settings.sound_type ?? 'choo-choo'}
              onValueChange={(value) => saveSetting('sound_type', value)}
            >
              <SelectTrigger id="sound-type">
                <SelectValue placeholder="Select sound type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="choo-choo">Choo Choo</SelectItem>
                <SelectItem value="beep">Beep</SelectItem>
                <SelectItem value="chime">Chime</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="diff-view">Diff view mode</Label>
            <Select
              value={settings.diff_view_mode ?? 'unified'}
              onValueChange={(value) => saveSetting('diff_view_mode', value)}
            >
              <SelectTrigger id="diff-view">
                <SelectValue placeholder="Select diff view" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="unified">Unified</SelectItem>
                <SelectItem value="split">Split</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">How to display code diffs</p>
          </div>
        </div>
      </div>
    );
  }

  function renderAccount() {
    return (
      <div className="settings-section space-y-6">
        <h2 className="text-2xl font-semibold">Account Settings</h2>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="user-name">Name</Label>
            <Input
              id="user-name"
              type="text"
              value={settings.user_name ?? ''}
              onChange={(e) => saveSetting('user_name', e.target.value)}
              placeholder="Your name"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="user-email">Email</Label>
            <Input
              id="user-email"
              type="email"
              value={settings.user_email ?? ''}
              onChange={(e) => saveSetting('user_email', e.target.value)}
              placeholder="your@email.com"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="github-username">GitHub Username</Label>
            <Input
              id="github-username"
              type="text"
              value={settings.user_github_username ?? ''}
              onChange={(e) => saveSetting('user_github_username', e.target.value)}
              placeholder="github-username"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="api-key">Anthropic API Key</Label>
            <Input
              id="api-key"
              type="password"
              value={settings.anthropic_api_key ?? ''}
              onChange={(e) => saveSetting('anthropic_api_key', e.target.value)}
              placeholder="sk-ant-api03-..."
            />
            <p className="text-sm text-muted-foreground">Your Anthropic API key for Claude models</p>
          </div>
        </div>
      </div>
    );
  }

  function renderTerminal() {
    return (
      <div className="settings-section space-y-6">
        <h2 className="text-2xl font-semibold">Terminal Settings</h2>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="font-size">Font size</Label>
            <Input
              id="font-size"
              type="number"
              min="8"
              max="24"
              value={settings.terminal_font_size ?? 12}
              onChange={(e) => saveSetting('terminal_font_size', parseInt(e.target.value))}
            />
            <p className="text-sm text-muted-foreground">Terminal font size in pixels</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="default-editor">Default editor</Label>
            <Select
              value={settings.default_open_in ?? 'cursor'}
              onValueChange={(value) => saveSetting('default_open_in', value)}
            >
              <SelectTrigger id="default-editor">
                <SelectValue placeholder="Select editor" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cursor">Cursor</SelectItem>
                <SelectItem value="vscode">VS Code</SelectItem>
                <SelectItem value="sublime">Sublime Text</SelectItem>
                <SelectItem value="vim">Vim</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">Which editor to open files in</p>
          </div>
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
      <div className="settings-section space-y-6">
        <div>
          <h2 className="text-2xl font-semibold">Memory Settings</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Configure how Claude remembers context across conversations
          </p>
        </div>

        <div className="space-y-4">
          <div className="flex items-center space-x-3">
            <Checkbox id="conversation-memory" defaultChecked />
            <div className="flex-1">
              <Label htmlFor="conversation-memory" className="text-base font-medium cursor-pointer">
                Enable conversation memory
              </Label>
              <p className="text-sm text-muted-foreground">Allow Claude to remember previous conversations</p>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="memory-retention">Memory retention</Label>
            <Select defaultValue="session">
              <SelectTrigger id="memory-retention">
                <SelectValue placeholder="Select retention period" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="session">Current session only</SelectItem>
                <SelectItem value="day">24 hours</SelectItem>
                <SelectItem value="week">7 days</SelectItem>
                <SelectItem value="forever">Forever</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Button variant="secondary">Clear All Memory</Button>
            <p className="text-sm text-muted-foreground">Remove all stored conversation context</p>
          </div>
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
      <div className="settings-section space-y-6">
        <div>
          <h2 className="text-2xl font-semibold">Provider Settings</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Configure the AI model provider and model selection
          </p>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="provider">Provider</Label>
            <Select
              value={settings.claude_provider ?? 'anthropic'}
              onValueChange={(value) => saveSetting('claude_provider', value)}
            >
              <SelectTrigger id="provider">
                <SelectValue placeholder="Select provider" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="anthropic">Anthropic (Official)</SelectItem>
                <SelectItem value="custom">Custom Endpoint</SelectItem>
                <SelectItem value="bedrock">AWS Bedrock</SelectItem>
                <SelectItem value="vertex">Google Vertex AI</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="model">Default Model</Label>
            <Select
              value={settings.claude_model ?? 'sonnet'}
              onValueChange={(value) => saveSetting('claude_model', value)}
            >
              <SelectTrigger id="model">
                <SelectValue placeholder="Select model" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sonnet">Claude 3.5 Sonnet (Recommended)</SelectItem>
                <SelectItem value="opus">Claude 3 Opus</SelectItem>
                <SelectItem value="haiku">Claude 3.5 Haiku</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">Default model for new conversations</p>
          </div>

          {settings.claude_provider === 'custom' && (
            <div className="space-y-2">
              <Label htmlFor="custom-endpoint">Custom Endpoint URL</Label>
              <Input
                id="custom-endpoint"
                type="url"
                placeholder="https://api.example.com/v1"
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  function renderExperimental() {
    return (
      <div className="settings-section space-y-6">
        <div>
          <h2 className="text-2xl font-semibold">Experimental Features</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Try out new features that are still in development
          </p>
        </div>

        <div className="space-y-4">
          <div className="flex items-center space-x-3">
            <Checkbox
              id="right-panel"
              checked={settings.right_panel_visible ?? true}
              onCheckedChange={(checked) => saveSetting('right_panel_visible', checked)}
            />
            <div className="flex-1">
              <Label htmlFor="right-panel" className="text-base font-medium cursor-pointer">
                Show right panel
              </Label>
              <p className="text-sm text-muted-foreground">Display additional information panel</p>
            </div>
          </div>

          <div className="flex items-center space-x-3">
            <Checkbox
              id="split-view"
              checked={settings.using_split_view ?? false}
              onCheckedChange={(checked) => saveSetting('using_split_view', checked)}
            />
            <div className="flex-1">
              <Label htmlFor="split-view" className="text-base font-medium cursor-pointer">
                Use split view
              </Label>
              <p className="text-sm text-muted-foreground">Show code and chat side by side</p>
            </div>
          </div>

          <div className="rounded-lg border border-warning bg-warning/10 p-4">
            <p className="text-sm text-warning-foreground">
              ⚠️ Experimental features may be unstable and could change at any time
            </p>
          </div>
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
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate('/')}
            title="Back to Dashboard"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="text-2xl font-semibold">Settings</h1>
        </div>
        {saving && <span className="text-sm text-muted-foreground">Saving...</span>}
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
