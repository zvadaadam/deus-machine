import { useState, useEffect, useCallback } from "react";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { Copy, Trash2, Smartphone, Monitor, RefreshCw, ArrowUpRight } from "lucide-react";
import { getErrorMessage } from "@shared/lib/errors";
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
          <ArrowUpRight className="size-3.5" />
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

// ---------------------------------------------------------------------------
// Main Section
// ---------------------------------------------------------------------------

/**
 * Unified Access settings section.
 *
 * Hierarchy:
 *   1. Toggle + hero portal card (URL, status, copy/open)
 *   2. Guided pairing flow (numbered steps with inline code generation)
 *   3. Paired devices list
 *
 * The portal URL is the hero because it answers the first question every
 * user has: "where do I go?" The pairing code is step 2 in that flow.
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
      toast.error(`Failed to generate code: ${getErrorMessage(error)}`);
    }
  }

  async function handleRevokeDevice(device: PairedDevice) {
    try {
      await revokeDeviceMutation.mutateAsync(device.id);
      toast.success(`Revoked "${device.name}"`);
    } catch (error) {
      toast.error(`Failed to revoke device: ${getErrorMessage(error)}`);
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
  // wss://relay.rundeus.com -> https://app.rundeus.com/server/{serverId}
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
          Access Deus from your phone or another browser.
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
        </>
      )}
    </div>
  );
}
