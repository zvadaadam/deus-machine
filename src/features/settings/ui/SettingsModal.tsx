import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import {
  Settings2,
  User,
  Terminal,
  Plug,
  Command,
  Bot,
  BrainCircuit,
  Webhook,
  Globe,
  FlaskConical,
  Loader2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
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
import type { SettingsSection } from "../types";

interface SettingsModalProps {
  show: boolean;
  onClose: () => void;
}

interface NavItem {
  id: SettingsSection;
  label: string;
  icon: LucideIcon;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Preferences",
    items: [
      { id: "general", label: "General", icon: Settings2 },
      { id: "account", label: "Account", icon: User },
    ],
  },
  {
    label: "AI & Tools",
    items: [
      { id: "provider", label: "Provider", icon: Globe },
      { id: "mcp", label: "MCP Servers", icon: Plug },
      { id: "commands", label: "Commands", icon: Command },
      { id: "agents", label: "Agents", icon: Bot },
    ],
  },
  {
    label: "Workspace",
    items: [
      { id: "terminal", label: "Terminal", icon: Terminal },
      { id: "memory", label: "Memory", icon: BrainCircuit },
      { id: "hooks", label: "Hooks", icon: Webhook },
    ],
  },
  {
    label: "Advanced",
    items: [{ id: "experimental", label: "Experimental", icon: FlaskConical }],
  },
];

export function SettingsModal({ show, onClose }: SettingsModalProps) {
  const { theme, setTheme } = useTheme();
  const [activeSection, setActiveSection] = useState<SettingsSection>("general");

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

  async function saveSetting(key: string, value: unknown) {
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
    return (
      <nav className="border-border w-52 shrink-0 border-r pr-2">
        <ScrollArea className="h-[560px]">
          <div className="space-y-4 py-1">
            {NAV_GROUPS.map((group) => (
              <div key={group.label}>
                <p className="text-muted-foreground/70 mb-1 px-3 text-[11px] font-medium tracking-wider uppercase">
                  {group.label}
                </p>
                <div className="space-y-0.5">
                  {group.items.map((item) => {
                    const isActive = activeSection === item.id;
                    const Icon = item.icon;
                    return (
                      <button
                        key={item.id}
                        onClick={() => setActiveSection(item.id)}
                        className={`ease flex w-full items-center gap-2.5 rounded-md px-3 py-1.5 text-[13px] transition-colors duration-150 ${
                          isActive
                            ? "bg-accent text-foreground font-medium"
                            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                        }`}
                      >
                        <Icon className="size-4 shrink-0" />
                        <span>{item.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      </nav>
    );
  }

  function renderMCP() {
    return (
      <div className="space-y-5">
        <SectionHeader
          title="MCP Servers"
          description="Model Context Protocol servers extend agent capabilities with external tools and data sources."
        />

        <div className="space-y-2.5">
          {mcpServers.length === 0 ? (
            <EmptyState message="No MCP servers configured" />
          ) : (
            mcpServers.map((server, index) => (
              <div key={index} className="border-border/60 rounded-lg border p-3">
                <p className="text-sm font-medium">{server.name}</p>
                <code className="bg-muted/50 text-muted-foreground mt-1.5 block overflow-x-auto rounded px-2 py-1 text-xs">
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
      <div className="space-y-5">
        <SectionHeader
          title="Custom Commands"
          description="Slash commands for frequently used prompts and workflows."
        />

        <div className="space-y-2.5">
          {commands.length === 0 ? (
            <EmptyState message="No custom commands defined" />
          ) : (
            commands.map((cmd, index) => (
              <div key={index} className="border-border/60 rounded-lg border p-3">
                <p className="text-sm font-medium">/{cmd.name}</p>
                <p className="text-muted-foreground mt-0.5 text-xs">{cmd.description}</p>
              </div>
            ))
          )}
        </div>
      </div>
    );
  }

  function renderAgents() {
    return (
      <div className="space-y-5">
        <SectionHeader
          title="Agent Configuration"
          description="Specialized agents with specific tool access and capabilities."
        />

        <div className="space-y-2.5">
          {agents.length === 0 ? (
            <EmptyState message="Using default agents" />
          ) : (
            agents.map((agent, index) => (
              <div key={index} className="border-border/60 rounded-lg border p-3">
                <p className="text-sm font-medium">{agent.name}</p>
                <p className="text-muted-foreground mt-0.5 text-xs">{agent.description}</p>
                {agent.tools?.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {agent.tools.map((tool, i) => (
                      <Badge key={i} variant="secondary" className="text-[11px] font-normal">
                        {tool}
                      </Badge>
                    ))}
                  </div>
                )}
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
      <div className="space-y-5">
        <SectionHeader
          title="Hooks"
          description="Run custom shell commands in response to application events."
        />

        <div className="space-y-2.5">
          {hookEntries.length === 0 ? (
            <EmptyState message="No hooks configured" />
          ) : (
            hookEntries.map(([event, command]) => (
              <div key={event} className="border-border/60 rounded-lg border p-3">
                <p className="text-sm font-medium">{event}</p>
                <code className="bg-muted/50 text-muted-foreground mt-1.5 block overflow-x-auto rounded px-2 py-1 text-xs">
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
      <div className="space-y-5">
        <SectionHeader
          title="Experimental"
          description="Features under development. These may be unstable or change without notice."
        />

        <div className="space-y-1">
          <SettingRow
            id="right-panel"
            label="Show right panel"
            description="Display the secondary panel alongside the chat view."
          >
            <Switch
              id="right-panel"
              checked={settings.right_panel_visible ?? true}
              onCheckedChange={(checked) => saveSetting("right_panel_visible", checked)}
            />
          </SettingRow>

          <SettingRow
            id="split-view"
            label="Use split view"
            description="Show two workspaces side by side."
          >
            <Switch
              id="split-view"
              checked={settings.using_split_view ?? false}
              onCheckedChange={(checked) => saveSetting("using_split_view", checked)}
            />
          </SettingRow>
        </div>
      </div>
    );
  }

  function renderContent() {
    if (loading) {
      return (
        <div className="flex h-80 items-center justify-center">
          <Loader2 className="text-muted-foreground size-5 animate-spin" />
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
      <DialogContent className="max-h-[85vh] max-w-3xl p-0">
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle className="flex items-center justify-between">
            <span>Settings</span>
            {saving && <span className="text-muted-foreground text-sm font-normal">Saving...</span>}
          </DialogTitle>
        </DialogHeader>

        <div className="flex px-6 pb-6">
          {renderNavigation()}
          <ScrollArea className="h-[560px] flex-1 pl-6">{renderContent()}</ScrollArea>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Reusable section header with title + description */
function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="text-muted-foreground mt-1 text-[13px]">{description}</p>
    </div>
  );
}

/** Reusable empty state placeholder */
function EmptyState({ message }: { message: string }) {
  return (
    <div className="border-border/60 bg-muted/20 rounded-lg border border-dashed px-4 py-8 text-center">
      <p className="text-muted-foreground text-sm">{message}</p>
    </div>
  );
}

/** Reusable horizontal setting row: label+description on left, control on right */
export function SettingRow({
  id,
  label,
  description,
  children,
}: {
  id: string;
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg px-1 py-3">
      <div className="min-w-0 flex-1">
        <Label htmlFor={id} className="cursor-pointer text-sm">
          {label}
        </Label>
        {description && <p className="text-muted-foreground mt-0.5 text-[13px]">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
