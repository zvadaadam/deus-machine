import { useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2 } from "lucide-react";
import { useTheme } from "@/app/providers";
import {
  useSettings,
  useMCPServers,
  useCommands,
  useAgents,
  useHooks,
  useUpdateSettings,
} from "../api/settings.queries";
import {
  GeneralSection,
  AccountSection,
  TerminalSection,
  MemorySection,
  ProviderSection,
} from "./sections";
import type { Settings, MCPServer, Command, Agent, Hook, SettingsSection } from "../types";

interface SettingsModalProps {
  show: boolean;
  onClose: () => void;
}

export function SettingsModal({ show, onClose }: SettingsModalProps) {
  const { theme, setTheme } = useTheme();
  const [activeSection, setActiveSection] = useState<SettingsSection>("general");

  // TanStack Query hooks - automatic loading and caching
  const settingsQuery = useSettings();
  const mcpServersQuery = useMCPServers();
  const commandsQuery = useCommands();
  const agentsQuery = useAgents();
  const hooksQuery = useHooks();
  const updateSettingsMutation = useUpdateSettings();

  const settings = settingsQuery.data || {};
  const mcpServers = mcpServersQuery.data || [];
  const commands = commandsQuery.data || [];
  const agents = agentsQuery.data || [];
  const hooks = hooksQuery.data || {};
  const loading = settingsQuery.isLoading;
  const saving = updateSettingsMutation.isPending;

  async function saveSetting(key: string, value: any) {
    try {
      await updateSettingsMutation.mutateAsync({ [key]: value });
    } catch (error) {
      console.error("Failed to save setting:", error);
      toast.error(
        `Failed to save setting: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  function renderNavigation() {
    const sections: { id: SettingsSection; label: string; icon: string }[] = [
      { id: "general", label: "General", icon: "⚙️" },
      { id: "account", label: "Account", icon: "👤" },
      { id: "terminal", label: "Terminal", icon: "💻" },
      { id: "mcp", label: "MCP", icon: "🔌" },
      { id: "commands", label: "Commands", icon: "📝" },
      { id: "agents", label: "Agents", icon: "🤖" },
      { id: "memory", label: "Memory", icon: "🧠" },
      { id: "hooks", label: "Hooks", icon: "🪝" },
      { id: "provider", label: "Provider", icon: "🌐" },
      { id: "experimental", label: "Experimental", icon: "🧪" },
    ];

    return (
      <nav className="border-border w-50 border-r pr-4">
        <ScrollArea className="h-[500px]">
          <div className="space-y-1">
            {sections.map((section) => (
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
          <p className="text-muted-foreground text-xs">Configure Model Context Protocol servers</p>
        </div>

        <div className="space-y-3">
          {mcpServers.length === 0 ? (
            <div className="bg-muted/30 rounded-lg border border-dashed px-4 py-8 text-center">
              <p className="text-muted-foreground text-sm">No MCP servers configured</p>
            </div>
          ) : (
            mcpServers.map((server, index) => (
              <div key={index} className="rounded-lg border p-3">
                <h4 className="mb-2 text-sm font-medium">{server.name}</h4>
                <code className="bg-muted block overflow-x-auto rounded p-1 text-xs">
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
          <p className="text-muted-foreground text-xs">
            Slash commands for frequently used prompts
          </p>
        </div>

        <div className="space-y-3">
          {commands.length === 0 ? (
            <div className="bg-muted/30 rounded-lg border border-dashed px-4 py-8 text-center">
              <p className="text-muted-foreground text-sm">No custom commands defined</p>
            </div>
          ) : (
            commands.map((cmd, index) => (
              <div key={index} className="rounded-lg border p-3">
                <h4 className="text-sm font-medium">/{cmd.name}</h4>
                <p className="text-muted-foreground text-xs">{cmd.description}</p>
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
          <p className="text-muted-foreground text-xs">
            Specialized agents with specific tool access
          </p>
        </div>

        <div className="space-y-3">
          {agents.length === 0 ? (
            <div className="bg-muted/30 rounded-lg border border-dashed px-4 py-8 text-center">
              <p className="text-muted-foreground text-sm">Using default agents</p>
            </div>
          ) : (
            agents.map((agent, index) => (
              <div key={index} className="rounded-lg border p-3">
                <h4 className="text-sm font-medium">{agent.name}</h4>
                <p className="text-muted-foreground mb-2 text-xs">{agent.description}</p>
                <div className="flex flex-wrap gap-1">
                  {agent.tools?.map((tool, i) => (
                    <span key={i} className="bg-success/10 rounded px-1.5 py-0.5 text-xs">
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
          <p className="text-muted-foreground text-xs">Run custom commands in response to events</p>
        </div>

        <div className="space-y-3">
          {hookEntries.length === 0 ? (
            <div className="bg-muted/30 rounded-lg border border-dashed px-4 py-8 text-center">
              <p className="text-muted-foreground text-sm">No hooks configured</p>
            </div>
          ) : (
            hookEntries.map(([event, command]) => (
              <div key={event} className="rounded-lg border p-3">
                <h4 className="mb-2 text-sm font-medium">{event}</h4>
                <code className="bg-muted block overflow-x-auto rounded p-1 text-xs">
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
              onCheckedChange={(checked) => saveSetting("right_panel_visible", checked === true)}
            />
            <Label htmlFor="right-panel" className="cursor-pointer text-sm">
              Show right panel
            </Label>
          </div>

          <div className="flex items-center space-x-2">
            <Checkbox
              id="split-view"
              checked={settings.using_split_view ?? false}
              onCheckedChange={(checked) => saveSetting("using_split_view", checked === true)}
            />
            <Label htmlFor="split-view" className="cursor-pointer text-sm">
              Use split view
            </Label>
          </div>

          <div className="border-warning bg-warning/10 rounded border p-3">
            <p className="text-warning-foreground text-xs">
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
        <div className="flex h-100 items-center justify-center">
          <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
        </div>
      );
    }

    const sectionProps = { settings, saveSetting };

    switch (activeSection) {
      case "general":
        return <GeneralSection {...sectionProps} theme={theme} setTheme={setTheme} />;
      case "account":
        return <AccountSection {...sectionProps} />;
      case "terminal":
        return <TerminalSection {...sectionProps} />;
      case "mcp":
        return renderMCP();
      case "commands":
        return renderCommands();
      case "agents":
        return renderAgents();
      case "memory":
        return <MemorySection {...sectionProps} />;
      case "hooks":
        return renderHooks();
      case "provider":
        return <ProviderSection {...sectionProps} />;
      case "experimental":
        return renderExperimental();
      default:
        return null;
    }
  }

  return (
    <Dialog open={show} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-[900px] p-0">
        <DialogHeader className="p-6 pb-4">
          <DialogTitle className="flex items-center justify-between">
            <span>Settings</span>
            {saving && <span className="text-muted-foreground text-sm font-normal">Saving...</span>}
          </DialogTitle>
        </DialogHeader>

        <div className="flex gap-6 px-6 pb-6">
          {renderNavigation()}
          <ScrollArea className="h-[500px] flex-1 pr-4">{renderContent()}</ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}
