import { useEffect } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { SidebarInset } from "@/components/ui/sidebar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useTheme } from "@/app/providers";
import { useUIStore } from "@/shared/stores/uiStore";
import {
  useSettings,
  useMCPServers,
  useCommands,
  useAgents,
  useUpdateSettings,
} from "../api/settings.queries";
import { GeneralSection, AISection, ExtensionsSection } from "./sections";

export function SettingsPage() {
  const activeSection = useUIStore((s) => s.activeSettingsSection);
  const closeSettings = useUIStore((s) => s.closeSettings);
  const { theme, setTheme } = useTheme();

  const settingsQuery = useSettings();
  const mcpServersQuery = useMCPServers();
  const commandsQuery = useCommands();
  const agentsQuery = useAgents();
  const updateSettingsMutation = useUpdateSettings();

  const settings = settingsQuery.data || {};
  const mcpServers = mcpServersQuery.data || [];
  const commands = commandsQuery.data || [];
  const agents = agentsQuery.data || [];
  const loading =
    activeSection === "extensions"
      ? settingsQuery.isLoading ||
        mcpServersQuery.isLoading ||
        commandsQuery.isLoading ||
        agentsQuery.isLoading
      : settingsQuery.isLoading;
  const saving = updateSettingsMutation.isPending;

  // ESC closes settings
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // Don't close if focus is in an input
      const ae = document.activeElement as HTMLElement | null;
      if (
        ae &&
        (ae.tagName === "INPUT" ||
          ae.tagName === "TEXTAREA" ||
          ae.isContentEditable ||
          ae.getAttribute("role") === "textbox")
      )
        return;
      closeSettings();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeSettings]);

  async function saveSetting(key: string, value: unknown): Promise<boolean> {
    try {
      await updateSettingsMutation.mutateAsync({ [key]: value });
      return true;
    } catch (error) {
      console.error("Failed to save setting:", error);
      toast.error(
        `Failed to save setting: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
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
      case "ai":
        return <AISection {...sectionProps} />;
      case "extensions":
        return <ExtensionsSection mcpServers={mcpServers} commands={commands} agents={agents} />;
      default:
        return null;
    }
  }

  return (
    <SidebarInset className="min-w-0">
      <div className="bg-bg-surface border-border-subtle flex h-full min-w-0 flex-1 overflow-hidden rounded-xl border">
        <ScrollArea className="flex-1">
          <div className="mx-auto max-w-2xl px-8 py-8">
            {/* Saving indicator */}
            {saving && (
              <div className="text-muted-foreground mb-4 flex items-center gap-2 text-sm">
                <Loader2 className="size-3.5 animate-spin" />
                <span>Saving...</span>
              </div>
            )}

            {renderContent()}
          </div>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
