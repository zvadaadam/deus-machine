import { useState, useEffect, useCallback } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { toast } from "sonner";
import {
  Copy,
  Trash2,
  Smartphone,
  Monitor,
  RefreshCw,
  ExternalLink,
  ChevronRight,
  Send,
  MessageSquare,
} from "lucide-react";
import {
  usePairedDevices,
  useGeneratePairCode,
  useRevokeDevice,
  useRelayStatus,
} from "../../api/auth.queries";
import type { PairedDevice } from "../../api/auth.service";
import type { SettingsSectionProps } from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function getDeviceIcon(ua: string | null) {
  if (!ua) return Monitor;
  const lower = ua.toLowerCase();
  if (lower.includes("mobile") || lower.includes("iphone") || lower.includes("android")) {
    return Smartphone;
  }
  return Monitor;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/**
 * Step indicator -- a small numbered circle used in the pairing flow.
 * Uses primary color when active, muted when dimmed.
 */
function StepDot({ n, dimmed }: { n: number; dimmed: boolean }) {
  return (
    <span
      className={`flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] leading-none font-semibold transition-colors duration-200 ${
        dimmed ? "bg-muted text-muted-foreground/60" : "bg-primary/10 text-primary"
      }`}
    >
      {n}
    </span>
  );
}

/**
 * Portal URL hero card.
 * The most important piece of information on this page -- where to go.
 * Rendered with subtle depth (border + background) and two action buttons.
 */
function PortalCard({
  url,
  connected,
  clients,
}: {
  url: string;
  connected: boolean;
  clients: number;
}) {
  return (
    <div className="border-border/60 bg-muted/30 space-y-3 rounded-xl border px-4 py-4">
      {/* Status line */}
      <div className="flex items-center gap-2.5">
        <span
          className={`size-[7px] shrink-0 rounded-full ${
            connected ? "bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.35)]" : "bg-red-400"
          }`}
        />
        <span className="text-muted-foreground text-xs font-medium">
          {connected ? "Connected to relay" : "Connecting..."}
        </span>
        {connected && clients > 0 && (
          <span className="text-muted-foreground/70 text-[11px]">
            &middot; {clients} {clients === 1 ? "client" : "clients"}
          </span>
        )}
      </div>

      {/* URL + actions */}
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate font-mono text-sm leading-relaxed">{url}</p>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          onClick={() => {
            navigator.clipboard.writeText(url);
            toast.success("URL copied");
          }}
          title="Copy URL"
        >
          <Copy className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          onClick={() => window.open(url, "_blank", "noopener")}
          title="Open in browser"
        >
          <ExternalLink className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

/**
 * Pairing flow -- numbered steps that guide the user through device pairing.
 *
 * When no code is active: shows steps 1-2 with a "Generate Code" button.
 * When a code is active: step 2 transforms to show the code + countdown,
 * and step 3 appears ("device will appear below once paired").
 */
function PairingFlow({
  accessUrl,
  pairCode,
  countdown,
  isGenerating,
  onGenerate,
  onCopyCode,
}: {
  accessUrl: string | null;
  pairCode: string | null;
  countdown: number;
  isGenerating: boolean;
  onGenerate: () => void;
  onCopyCode: () => void;
}) {
  return (
    <div className="space-y-3">
      <h4 className="text-sm font-medium">Pair a Device</h4>

      <div className="space-y-0.5">
        {/* Step 1 */}
        <div className="flex gap-3 py-2">
          <StepDot n={1} dimmed={false} />
          <p className="pt-px text-sm">
            Open{" "}
            {accessUrl ? (
              <button
                type="button"
                className="text-primary font-medium underline-offset-2 hover:underline"
                onClick={() => {
                  navigator.clipboard.writeText(accessUrl);
                  toast.success("URL copied");
                }}
              >
                the portal URL
              </button>
            ) : (
              <span className="text-muted-foreground">your access URL</span>
            )}{" "}
            on the other device
          </p>
        </div>

        {/* Step 2 */}
        <div className="flex gap-3 py-2">
          <StepDot n={2} dimmed={!accessUrl && !pairCode} />
          <div className="min-w-0 flex-1 pt-px">
            {pairCode ? (
              <div className="space-y-2">
                <p className="text-sm">Enter this code on the other device</p>
                <div className="bg-muted/40 flex items-center justify-between rounded-lg px-4 py-3.5">
                  <span className="font-mono text-2xl font-bold tracking-[0.15em]">{pairCode}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    onClick={onCopyCode}
                    title="Copy code"
                  >
                    <Copy className="size-3.5" />
                  </Button>
                </div>
                <p className="text-muted-foreground text-xs">
                  Expires in {Math.floor(countdown / 60)}:{String(countdown % 60).padStart(2, "0")}
                </p>
              </div>
            ) : (
              <div className="space-y-2.5">
                <p className="text-muted-foreground text-sm">Generate a one-time pairing code</p>
                <Button variant="outline" size="sm" onClick={onGenerate} disabled={isGenerating}>
                  {isGenerating && <RefreshCw className="mr-2 size-3.5 animate-spin" />}
                  Generate Code
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* Step 3 -- visible only when code is active */}
        {pairCode && (
          <div className="flex gap-3 py-2">
            <StepDot n={3} dimmed={false} />
            <p className="text-muted-foreground pt-px text-sm">
              The device will appear below once paired
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Paired devices list with revoke action per device.
 */
function DevicesList({
  devices,
  onRevoke,
  isRevoking,
}: {
  devices: PairedDevice[];
  onRevoke: (device: PairedDevice) => void;
  isRevoking: boolean;
}) {
  if (devices.length === 0) {
    return <p className="text-muted-foreground py-0.5 text-sm">No devices paired yet.</p>;
  }

  return (
    <div className="space-y-1.5">
      {devices.map((device) => {
        const DeviceIcon = getDeviceIcon(device.user_agent);
        return (
          <div
            key={device.id}
            className="bg-muted/30 flex items-center justify-between rounded-lg px-4 py-2.5"
          >
            <div className="flex items-center gap-3">
              <DeviceIcon className="text-muted-foreground size-4 shrink-0" />
              <div>
                <p className="text-sm font-medium">{device.name}</p>
                <p className="text-muted-foreground text-xs">
                  {timeAgo(device.last_seen_at)}
                  {device.ip_address ? ` \u00b7 ${device.ip_address}` : ""}
                </p>
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-destructive size-7"
              onClick={() => onRevoke(device)}
              disabled={isRevoking}
              title={`Revoke ${device.name}`}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Chat Bots -- collapsible sub-section for Telegram & WhatsApp.
 *
 * These are power-user features. Making them collapsible keeps the primary
 * pairing flow clean while remaining fully accessible to those who need it.
 * Auto-expands if any channel is already configured (returning users).
 */
function ChatBotsSubsection({ settings, saveSetting }: SettingsSectionProps) {
  const [gatewayRunning, setGatewayRunning] = useState<boolean | null>(null);
  const [toggling, setToggling] = useState(false);
  const [open, setOpen] = useState(false);

  const hasTelegram = Boolean(settings.telegram_bot_token);
  const hasWhatsApp = Boolean(settings.whatsapp_session_dir);
  const hasAnyChannel = hasTelegram || hasWhatsApp;

  // Check gateway status via Tauri IPC
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

  // Auto-expand for returning users who already configured a channel
  useEffect(() => {
    if (hasAnyChannel) setOpen(true);
  }, [hasAnyChannel]);

  async function handleToggleGateway(on: boolean) {
    setToggling(true);
    try {
      await saveSetting("gateway_enabled", on);
      const { invoke } = await import("@tauri-apps/api/core");
      if (on) {
        await invoke("start_gateway");
        toast.success("Chat bot gateway started");
      } else {
        await invoke("stop_gateway");
        toast.success("Chat bot gateway stopped");
      }
      const running = await invoke<boolean>("is_gateway_running");
      setGatewayRunning(running);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      toast.error(`Gateway ${on ? "start" : "stop"} failed: ${msg}`);
      await saveSetting("gateway_enabled", !on);
    } finally {
      setToggling(false);
    }
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="group flex w-full items-center justify-between py-0.5">
        <div className="flex items-center gap-2.5">
          <h4 className="text-sm font-medium">Chat Bots</h4>
          {gatewayRunning === true && (
            <Badge variant="secondary" className="text-[11px]">
              Running
            </Badge>
          )}
          {gatewayRunning !== true && hasAnyChannel && (
            <Badge variant="outline" className="text-muted-foreground text-[11px]">
              Configured
            </Badge>
          )}
        </div>
        <ChevronRight className="text-muted-foreground size-4 transition-transform duration-200 ease-out group-data-[state=open]:rotate-90" />
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="mt-4 space-y-5">
          <p className="text-muted-foreground text-sm">
            Control your AI agents remotely via Telegram or WhatsApp.
          </p>

          {/* Gateway toggle */}
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="gateway-enabled" className="text-sm">
                Enable gateway
              </Label>
              <p className="text-muted-foreground text-xs">
                {hasAnyChannel
                  ? "Start the bot gateway to receive messages."
                  : "Configure a channel below first."}
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
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Send className="text-muted-foreground size-3.5" />
              <Label htmlFor="telegram-token" className="text-sm font-medium">
                Telegram
              </Label>
              {hasTelegram && (
                <Badge variant="outline" className="text-[11px]">
                  Configured
                </Badge>
              )}
            </div>
            <p className="text-muted-foreground text-xs">
              Create a bot via <span className="font-mono text-[11px]">@BotFather</span> and paste
              the token.
            </p>
            <Input
              id="telegram-token"
              type="password"
              defaultValue={settings.telegram_bot_token ?? ""}
              onBlur={(e) => saveSetting("telegram_bot_token", e.currentTarget.value)}
              placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
            />
          </div>

          <Separator />

          {/* WhatsApp */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <MessageSquare className="text-muted-foreground size-3.5" />
              <Label htmlFor="whatsapp-session" className="text-sm font-medium">
                WhatsApp
              </Label>
              {hasWhatsApp && (
                <Badge variant="outline" className="text-[11px]">
                  Configured
                </Badge>
              )}
            </div>
            <p className="text-muted-foreground text-xs">
              Local directory for session data. On first connection, scan a QR code in the terminal.
            </p>
            <Input
              id="whatsapp-session"
              defaultValue={settings.whatsapp_session_dir ?? ""}
              onBlur={(e) => saveSetting("whatsapp_session_dir", e.currentTarget.value)}
              placeholder="~/.hive/whatsapp-session"
            />
          </div>

          <Separator />

          {/* Allowed user IDs */}
          <div className="space-y-2">
            <Label htmlFor="allowed-users" className="text-sm">
              Allowed user IDs
            </Label>
            <p className="text-muted-foreground text-xs">
              Comma-separated Telegram/WhatsApp user IDs. Leave empty to allow everyone.
            </p>
            <Input
              id="allowed-users"
              defaultValue={settings.gateway_allowed_user_ids ?? ""}
              onBlur={(e) => saveSetting("gateway_allowed_user_ids", e.currentTarget.value)}
              placeholder="123456789, 987654321"
            />
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ---------------------------------------------------------------------------
// Main Section
// ---------------------------------------------------------------------------

/**
 * Unified Access settings section.
 *
 * Merges the old "Remote Access" and "Messaging" sections into one page
 * with a clear top-down hierarchy:
 *
 *   1. Toggle + hero portal card (URL, status, copy/open)
 *   2. Guided pairing flow (numbered steps with inline code generation)
 *   3. Paired devices list
 *   4. Chat Bots (collapsible -- Telegram/WhatsApp configuration)
 *
 * Design rationale: "access Hive from elsewhere" is one user intention.
 * The portal URL is the hero because it answers the first question every
 * user has: "where do I go?" The pairing code is step 2 in that flow.
 * Messaging channels are a secondary, power-user concern and live in a
 * collapsible section that auto-expands when already configured.
 */
export function AccessSection({ settings, saveSetting }: SettingsSectionProps) {
  const enabled = settings.remote_access_enabled === true;

  // Remote access queries -- only active when enabled
  const devicesQuery = usePairedDevices(enabled);
  const relayQuery = useRelayStatus(enabled);
  const generateCodeMutation = useGeneratePairCode();
  const revokeDeviceMutation = useRevokeDevice();

  // Pairing code state
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [codeExpiresAt, setCodeExpiresAt] = useState(0);
  const [countdown, setCountdown] = useState(0);

  // Countdown timer for pairing code expiry
  useEffect(() => {
    if (!pairCode || codeExpiresAt <= 0) return;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((codeExpiresAt - Date.now()) / 1000));
      setCountdown(remaining);
      if (remaining <= 0) {
        setPairCode(null);
        setCodeExpiresAt(0);
      }
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [pairCode, codeExpiresAt]);

  // -- Handlers --

  const handleToggle = useCallback(
    async (on: boolean) => {
      const ok = await saveSetting("remote_access_enabled", on);
      if (ok) {
        toast.success(on ? "Remote access enabled" : "Remote access disabled");
        if (!on) {
          setPairCode(null);
          setCodeExpiresAt(0);
        }
      }
    },
    [saveSetting]
  );

  async function handleGenerateCode() {
    try {
      const result = await generateCodeMutation.mutateAsync();
      setPairCode(result.code);
      setCodeExpiresAt(Date.now() + result.expires_in_seconds * 1000);
    } catch (error) {
      toast.error(
        `Failed to generate code: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async function handleRevokeDevice(device: PairedDevice) {
    try {
      await revokeDeviceMutation.mutateAsync(device.id);
      toast.success(`Revoked "${device.name}"`);
    } catch (error) {
      toast.error(
        `Failed to revoke device: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  function handleCopyCode() {
    if (!pairCode) return;
    navigator.clipboard.writeText(pairCode);
    toast.success("Code copied");
  }

  // -- Derived values --

  const relayStatus = relayQuery.data;
  const devices = devicesQuery.data ?? [];

  // Derive web app URL from relay WebSocket URL
  // wss://relay.opendevs.sh -> https://app.opendevs.sh/server/{serverId}
  const accessUrl = (() => {
    if (!relayStatus?.relayUrl || !relayStatus.serverId) return null;
    try {
      const url = new URL(relayStatus.relayUrl);
      const host = url.hostname;
      const domain = host.replace(/^relay\./, "app.");
      return `https://${domain}/server/${relayStatus.serverId}`;
    } catch {
      return null;
    }
  })();

  // -- Render --

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h3 className="text-base font-semibold">Connect</h3>
        <p className="text-muted-foreground mt-1 text-sm">
          Access Hive from your phone, another browser, or a chat bot.
        </p>
      </div>

      {/* Master toggle */}
      <div className="flex items-center justify-between">
        <div>
          <Label htmlFor="remote-access-toggle" className="text-sm">
            Enable remote access
          </Label>
          <p className="text-muted-foreground text-xs">
            Connects to the cloud relay so other devices can reach this machine.
          </p>
        </div>
        <Switch id="remote-access-toggle" checked={enabled} onCheckedChange={handleToggle} />
      </div>

      {/* ----- Everything below is gated on the toggle ----- */}

      {enabled && (
        <>
          {/* Portal card -- hero element: URL + status */}
          {accessUrl && relayStatus && (
            <PortalCard
              url={accessUrl}
              connected={relayStatus.connected}
              clients={relayStatus.clients}
            />
          )}

          {/* Disconnected state without URL -- relay not configured yet */}
          {relayStatus && !accessUrl && (
            <div className="bg-muted/30 flex items-center gap-2.5 rounded-lg px-4 py-3">
              <span className="size-[7px] shrink-0 rounded-full bg-amber-400" />
              <span className="text-muted-foreground text-sm">
                {relayStatus.connected
                  ? "Connected — waiting for server ID..."
                  : "Connecting to relay..."}
              </span>
            </div>
          )}

          <Separator />

          {/* Guided pairing flow */}
          <PairingFlow
            accessUrl={accessUrl}
            pairCode={pairCode}
            countdown={countdown}
            isGenerating={generateCodeMutation.isPending}
            onGenerate={handleGenerateCode}
            onCopyCode={handleCopyCode}
          />

          <Separator />

          {/* Paired devices */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <h4 className="text-sm font-medium">Paired Devices</h4>
              {devices.length > 0 && (
                <Badge variant="secondary" className="text-[11px]">
                  {devices.length}
                </Badge>
              )}
            </div>
            <DevicesList
              devices={devices}
              onRevoke={handleRevokeDevice}
              isRevoking={revokeDeviceMutation.isPending}
            />
          </div>

          <Separator />

          {/* Chat Bots -- collapsible sub-section for Telegram/WhatsApp */}
          <ChatBotsSubsection settings={settings} saveSetting={saveSetting} />
        </>
      )}
    </div>
  );
}
