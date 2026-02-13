import { useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Settings2, Sparkles, Puzzle, Loader2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTheme } from "@/app/providers";
import {
  useSettings,
  useMCPServers,
  useCommands,
  useAgents,
  useUpdateSettings,
} from "../api/settings.queries";
import { GeneralSection, AISection, ExtensionsSection } from "./sections";
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

const NAV_ITEMS: NavItem[] = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "ai", label: "AI", icon: Sparkles },
  { id: "extensions", label: "Extensions", icon: Puzzle },
];

export function SettingsModal({ show, onClose }: SettingsModalProps) {
  const { theme, setTheme } = useTheme();
  const [activeSection, setActiveSection] = useState<SettingsSection>("general");

  const settingsQuery = useSettings();
  const mcpServersQuery = useMCPServers();
  const commandsQuery = useCommands();
  const agentsQuery = useAgents();
  const updateSettingsMutation = useUpdateSettings();

  const settings = settingsQuery.data || {};
  const mcpServers = mcpServersQuery.data || [];
  const commands = commandsQuery.data || [];
  const agents = agentsQuery.data || [];
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
      <nav className="border-border w-48 shrink-0 border-r pr-2">
        <div className="space-y-0.5 py-1">
          {NAV_ITEMS.map((item) => {
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
      </nav>
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
        return (
          <GeneralSection {...sectionProps} theme={theme} setTheme={setTheme} onClose={onClose} />
        );
      case "ai":
        return <AISection {...sectionProps} />;
      case "extensions":
        return <ExtensionsSection mcpServers={mcpServers} commands={commands} agents={agents} />;
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
