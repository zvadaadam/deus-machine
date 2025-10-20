import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { getBaseURL } from '@/config/api.config';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { ScrollArea } from '@/components/ui/scroll-area';
import { Loader2 } from 'lucide-react';
import { useTheme } from '@/hooks/useTheme';
import {
  GeneralSection,
  AccountSection,
  TerminalSection,
  MemorySection,
  ProviderSection,
} from './settings-sections';
import type {
  Settings,
  MCPServer,
  Command,
  Agent,
  Hook,
  SettingsSection,
} from '@/types';

interface SettingsModalProps {
  show: boolean;
  onClose: () => void;
}

export function SettingsModal({ show, onClose }: SettingsModalProps) {
  const { theme, setTheme } = useTheme();
  const [activeSection, setActiveSection] = useState<SettingsSection>('general');
  const [settings, setSettings] = useState<Settings>({});
  const [mcpServers, setMcpServers] = useState<MCPServer[]>([]);
  const [commands, setCommands] = useState<Command[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [hooks, setHooks] = useState<Hook>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (show) {
      loadSettings();
      loadFileBasedConfigs();
    }
  }, [show]);

  async function loadSettings() {
    try {
      const baseURL = await getBaseURL();
      const response = await fetch(`${baseURL}/settings`);
      if (!response.ok) throw new Error(`Failed to load settings: ${response.status}`);
      const data = await response.json();
      setSettings(data);
      setLoading(false);
    } catch (error) {
      console.error('Failed to load settings:', error);
      setLoading(false);
    }
  }

  async function fetchJson(url: string) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} → ${res.status}`);
    return res.json();
  }

  async function loadFileBasedConfigs() {
    try {
      const baseURL = await getBaseURL();

      const [mcpData, commandsData, agentsData, hooksData] = await Promise.all([
        fetchJson(`${baseURL}/config/mcp-servers`),
        fetchJson(`${baseURL}/config/commands`),
        fetchJson(`${baseURL}/config/agents`),
        fetchJson(`${baseURL}/config/hooks`),
      ]);

      setMcpServers(mcpData);
      setCommands(commandsData);
      setAgents(agentsData);
      setHooks(hooksData);
    } catch (error) {
      console.error('Failed to load file-based configs:', error);
    }
  }

  async function saveSetting(key: string, value: any) {
    setSaving(true);
    try {
      const baseURL = await getBaseURL();
      const res = await fetch(`${baseURL}/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value })
      });
      if (!res.ok) {
        throw new Error(`Failed to save: ${res.status}`);
      }
      setSettings(prev => ({ ...prev, [key]: value }));
    } catch (error) {
      console.error('Failed to save setting:', error);
      toast.error('Failed to save setting');
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
      <nav className="w-[200px] border-r border-border pr-4">
        <ScrollArea className="h-[500px]">
          <div className="space-y-1">
            {sections.map(section => (
              <Button
                key={section.id}
                variant={activeSection === section.id ? "default" : "ghost"}
                className="w-full justify-start gap-2 text-sm"
                size="sm"
                onClick={() => setActiveSection(section.id)}
              >
                <span>{section.icon}</span>
                <span>{section.label}</span>
              </Button>
            ))}
          </div>
        </ScrollArea>
      </nav>
    );
  }


  function renderMCP() {
    return (
      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-semibold">MCP Servers</h3>
          <p className="text-xs text-muted-foreground">Configure Model Context Protocol servers</p>
        </div>

        <div className="space-y-3">
          {mcpServers.length === 0 ? (
            <div className="text-center py-8 px-4 bg-muted/30 rounded-lg border border-dashed">
              <p className="text-sm text-muted-foreground">No MCP servers configured</p>
            </div>
          ) : (
            mcpServers.map((server, index) => (
              <div key={index} className="border rounded-lg p-3">
                <h4 className="font-medium text-sm mb-2">{server.name}</h4>
                <code className="text-xs bg-muted p-1 rounded block overflow-x-auto">
                  {server.command}
                </code>
              </div>
            ))
          )}
        </div>
      </div>
    );
  }

  function renderCommands() {
    return (
      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-semibold">Custom Commands</h3>
          <p className="text-xs text-muted-foreground">Slash commands for frequently used prompts</p>
        </div>

        <div className="space-y-3">
          {commands.length === 0 ? (
            <div className="text-center py-8 px-4 bg-muted/30 rounded-lg border border-dashed">
              <p className="text-sm text-muted-foreground">No custom commands defined</p>
            </div>
          ) : (
            commands.map((cmd, index) => (
              <div key={index} className="border rounded-lg p-3">
                <h4 className="font-medium text-sm">/{cmd.name}</h4>
                <p className="text-xs text-muted-foreground">{cmd.description}</p>
              </div>
            ))
          )}
        </div>
      </div>
    );
  }

  function renderAgents() {
    return (
      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-semibold">Agent Configuration</h3>
          <p className="text-xs text-muted-foreground">Specialized agents with specific tool access</p>
        </div>

        <div className="space-y-3">
          {agents.length === 0 ? (
            <div className="text-center py-8 px-4 bg-muted/30 rounded-lg border border-dashed">
              <p className="text-sm text-muted-foreground">Using default agents</p>
            </div>
          ) : (
            agents.map((agent, index) => (
              <div key={index} className="border rounded-lg p-3">
                <h4 className="font-medium text-sm">{agent.name}</h4>
                <p className="text-xs text-muted-foreground mb-2">{agent.description}</p>
                <div className="flex flex-wrap gap-1">
                  {agent.tools?.map((tool, i) => (
                    <span key={i} className="px-1.5 py-0.5 bg-success/10 rounded text-xs">
                      {tool}
                    </span>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    );
  }


  function renderHooks() {
    const hookEntries = Object.entries(hooks);

    return (
      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-semibold">Hooks Configuration</h3>
          <p className="text-xs text-muted-foreground">Run custom commands in response to events</p>
        </div>

        <div className="space-y-3">
          {hookEntries.length === 0 ? (
            <div className="text-center py-8 px-4 bg-muted/30 rounded-lg border border-dashed">
              <p className="text-sm text-muted-foreground">No hooks configured</p>
            </div>
          ) : (
            hookEntries.map(([event, command], index) => (
              <div key={index} className="border rounded-lg p-3">
                <h4 className="font-medium text-sm mb-2">{event}</h4>
                <code className="text-xs bg-muted p-1 rounded block overflow-x-auto">
                  {command}
                </code>
              </div>
            ))
          )}
        </div>
      </div>
    );
  }


  function renderExperimental() {
    return (
      <div className="space-y-4">
        <h3 className="text-lg font-semibold">Experimental Features</h3>

        <div className="space-y-3">
          <div className="flex items-center space-x-2">
            <Checkbox
              id="right-panel"
              checked={settings.right_panel_visible ?? true}
              onCheckedChange={(checked) => saveSetting('right_panel_visible', checked === true)}
            />
            <Label htmlFor="right-panel" className="text-sm cursor-pointer">
              Show right panel
            </Label>
          </div>

          <div className="flex items-center space-x-2">
            <Checkbox
              id="split-view"
              checked={settings.using_split_view ?? false}
              onCheckedChange={(checked) => saveSetting('using_split_view', checked === true)}
            />
            <Label htmlFor="split-view" className="text-sm cursor-pointer">
              Use split view
            </Label>
          </div>

          <div className="rounded border border-warning bg-warning/10 p-3">
            <p className="text-xs text-warning-foreground">
              ⚠️ Experimental features may be unstable
            </p>
          </div>
        </div>
      </div>
    );
  }

  function renderContent() {
    if (loading) {
      return (
        <div className="flex items-center justify-center h-[400px]">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      );
    }

    const sectionProps = { settings, setSettings, saveSetting };

    switch (activeSection) {
      case 'general':
        return <GeneralSection {...sectionProps} theme={theme} setTheme={setTheme} />;
      case 'account':
        return <AccountSection {...sectionProps} />;
      case 'terminal':
        return <TerminalSection {...sectionProps} />;
      case 'mcp':
        return renderMCP();
      case 'commands':
        return renderCommands();
      case 'agents':
        return renderAgents();
      case 'memory':
        return <MemorySection {...sectionProps} />;
      case 'hooks':
        return renderHooks();
      case 'provider':
        return <ProviderSection {...sectionProps} />;
      case 'experimental':
        return renderExperimental();
      default:
        return null;
    }
  }

  return (
    <Dialog open={show} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[900px] max-h-[85vh] p-0">
        <DialogHeader className="p-6 pb-4">
          <DialogTitle className="flex items-center justify-between">
            <span>Settings</span>
            {saving && (
              <span className="text-sm text-muted-foreground font-normal">
                Saving...
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="flex px-6 pb-6 gap-6">
          {renderNavigation()}
          <ScrollArea className="flex-1 h-[500px] pr-4">
            {renderContent()}
          </ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}
