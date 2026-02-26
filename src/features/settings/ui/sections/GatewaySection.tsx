import { useState, useEffect } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { MessageSquare, Send } from "lucide-react";
import type { SettingsSectionProps } from "./types";

/**
 * Gateway / Messaging settings section.
 * Configure Telegram and WhatsApp channels for remote agent control.
 *
 * Settings are saved to preferences.json via the backend API. The Rust GatewayManager
 * reads tokens from the same preferences.json when starting the gateway.
 * The toggle calls start_gateway / stop_gateway Tauri IPC commands directly.
 */
export function GatewaySection({ settings, saveSetting }: SettingsSectionProps) {
  const [gatewayRunning, setGatewayRunning] = useState<boolean | null>(null);
  const [toggling, setToggling] = useState(false);

  // Check gateway status via Tauri IPC (if available)
  useEffect(() => {
    let cancelled = false;
    async function checkStatus() {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const running = await invoke<boolean>("is_gateway_running");
        if (!cancelled) setGatewayRunning(running);
      } catch {
        if (!cancelled) setGatewayRunning(null);
      }
    }
    checkStatus();
    const interval = setInterval(checkStatus, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const hasTelegram = Boolean(settings.telegram_bot_token);
  const hasWhatsApp = Boolean(settings.whatsapp_session_dir);
  const hasAnyChannel = hasTelegram || hasWhatsApp;

  async function handleToggleGateway(enabled: boolean) {
    setToggling(true);
    try {
      // Save the preference first
      await saveSetting("gateway_enabled", enabled);

      const { invoke } = await import("@tauri-apps/api/core");

      if (enabled) {
        // Start gateway — Rust reads tokens from DB and resolves paths internally
        await invoke("start_gateway");
        toast.success("Messaging gateway started");
      } else {
        await invoke("stop_gateway");
        toast.success("Messaging gateway stopped");
      }

      // Refresh status immediately
      const running = await invoke<boolean>("is_gateway_running");
      setGatewayRunning(running);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      toast.error(`Gateway ${enabled ? "start" : "stop"} failed: ${msg}`);
      // Revert the setting on failure
      await saveSetting("gateway_enabled", !enabled);
    } finally {
      setToggling(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold">Messaging</h3>
        <p className="text-muted-foreground mt-1 text-base">
          Control your AI agents remotely from Telegram or WhatsApp.
        </p>
      </div>

      {/* Gateway status */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <MessageSquare className="text-muted-foreground size-4" />
          <span className="text-sm">Gateway status</span>
        </div>
        {gatewayRunning === null ? (
          <Badge variant="outline" className="text-muted-foreground">
            Unknown
          </Badge>
        ) : gatewayRunning ? (
          <Badge variant="default" className="bg-emerald-600 text-white">
            Running
          </Badge>
        ) : (
          <Badge variant="outline" className="text-muted-foreground">
            Stopped
          </Badge>
        )}
      </div>

      {/* Enable gateway toggle */}
      <div className="flex items-center justify-between">
        <div>
          <Label htmlFor="gateway-enabled" className="text-sm">
            Enable messaging gateway
          </Label>
          <p className="text-muted-foreground text-base">
            {hasAnyChannel
              ? "Start the gateway to receive messages from Telegram or WhatsApp."
              : "Configure a channel below first, then enable the gateway."}
          </p>
        </div>
        <Switch
          id="gateway-enabled"
          checked={settings.gateway_enabled ?? false}
          disabled={toggling || (!hasAnyChannel && !(settings.gateway_enabled ?? false))}
          onCheckedChange={handleToggleGateway}
        />
      </div>

      <Separator />

      {/* Telegram */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Send className="text-muted-foreground size-4" />
          <h4 className="text-sm font-medium">Telegram</h4>
          {hasTelegram && (
            <Badge variant="outline" className="text-xs">
              Configured
            </Badge>
          )}
        </div>
        <p className="text-muted-foreground text-base">
          Create a bot via{" "}
          <span className="font-mono text-xs">@BotFather</span> on Telegram and
          paste the token below.
        </p>
        <div className="space-y-2">
          <Label htmlFor="telegram-token" className="text-sm">
            Bot token
          </Label>
          <Input
            id="telegram-token"
            type="password"
            defaultValue={settings.telegram_bot_token ?? ""}
            onBlur={(e) => saveSetting("telegram_bot_token", e.currentTarget.value)}
            placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
          />
        </div>
      </div>

      <Separator />

      {/* WhatsApp */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <MessageSquare className="text-muted-foreground size-4" />
          <h4 className="text-sm font-medium">WhatsApp</h4>
          {hasWhatsApp && (
            <Badge variant="outline" className="text-xs">
              Configured
            </Badge>
          )}
        </div>
        <p className="text-muted-foreground text-base">
          Provide a local directory for WhatsApp session data. On first
          connection, you'll scan a QR code in the terminal.
        </p>
        <div className="space-y-2">
          <Label htmlFor="whatsapp-session" className="text-sm">
            Session directory
          </Label>
          <Input
            id="whatsapp-session"
            defaultValue={settings.whatsapp_session_dir ?? ""}
            onBlur={(e) => saveSetting("whatsapp_session_dir", e.currentTarget.value)}
            placeholder="~/.opendevs/whatsapp-session"
          />
        </div>
      </div>

      <Separator />

      {/* Allowed users */}
      <div className="space-y-2">
        <Label htmlFor="allowed-users" className="text-sm">
          Allowed user IDs
        </Label>
        <p className="text-muted-foreground text-base">
          Comma-separated list of Telegram/WhatsApp user IDs. Leave empty to
          allow everyone.
        </p>
        <Input
          id="allowed-users"
          defaultValue={settings.gateway_allowed_user_ids ?? ""}
          onBlur={(e) => saveSetting("gateway_allowed_user_ids", e.currentTarget.value)}
          placeholder="123456789, 987654321"
        />
      </div>
    </div>
  );
}
