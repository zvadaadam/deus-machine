import { useState, useEffect, useCallback } from "react";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { Copy, Trash2, Smartphone, Monitor, RefreshCw } from "lucide-react";
import {
  usePairedDevices,
  useGeneratePairCode,
  useRevokeDevice,
  useRelayStatus,
} from "../../api/auth.queries";
import type { PairedDevice } from "../../api/auth.service";
import type { SettingsSectionProps } from "./types";

/** Format relative time: "2 hours ago", "just now", etc. */
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

/** Detect device type from user agent string. */
function getDeviceIcon(ua: string | null) {
  if (!ua) return Monitor;
  const lower = ua.toLowerCase();
  if (lower.includes("mobile") || lower.includes("iphone") || lower.includes("android")) {
    return Smartphone;
  }
  return Monitor;
}

export function RemoteAccessSection({ settings, saveSetting }: SettingsSectionProps) {
  const enabled = settings.remote_access_enabled === true;

  // Queries — only active when remote access is ON
  const devicesQuery = usePairedDevices(enabled);
  const relayQuery = useRelayStatus(enabled);
  const generateCodeMutation = useGeneratePairCode();
  const revokeDeviceMutation = useRevokeDevice();

  // Pairing code state
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [codeExpiresAt, setCodeExpiresAt] = useState<number>(0);
  const [countdown, setCountdown] = useState(0);

  // Countdown timer for pairing code
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

  function copyToClipboard(text: string, label: string) {
    navigator.clipboard.writeText(text);
    toast.success(`${label} copied`);
  }

  const relayStatus = relayQuery.data;
  const devices = devicesQuery.data ?? [];

  // Derive the web app URL from the relay WebSocket URL
  // e.g., wss://relay.rundeus.com → https://app.rundeus.com/server/{serverId}
  const accessUrl = (() => {
    if (!relayStatus?.relayUrl || !relayStatus.serverId) return null;
    try {
      const url = new URL(relayStatus.relayUrl);
      const host = url.hostname; // e.g., relay.rundeus.com
      const domain = host.replace(/^relay\./, "app.");
      return `https://${domain}/server/${relayStatus.serverId}`;
    } catch {
      return null;
    }
  })();

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <h3 className="text-base font-semibold">Remote Access</h3>
        <p className="text-muted-foreground mt-1 text-base">
          Connect to Deus from your phone or another browser via the cloud relay.
        </p>
      </div>

      {/* Toggle */}
      <div className="flex items-center justify-between">
        <div>
          <Label htmlFor="remote-access-enabled" className="text-sm">
            Enable remote access
          </Label>
          <p className="text-muted-foreground text-base">
            Allow connections from other devices via the cloud relay.
          </p>
        </div>
        <Switch id="remote-access-enabled" checked={enabled} onCheckedChange={handleToggle} />
      </div>

      {/* Expanded content when enabled */}
      {enabled && (
        <>
          <Separator />

          {/* Relay connection status */}
          <div className="space-y-3">
            <h4 className="text-sm font-medium">Connection</h4>
            <div className="bg-muted/50 space-y-3 rounded-lg px-4 py-3">
              <div className="flex items-center gap-3">
                <span
                  className={`size-2 shrink-0 rounded-full ${
                    relayStatus?.connected ? "bg-emerald-500" : "bg-red-500"
                  }`}
                />
                <div>
                  <p className="text-sm font-medium">
                    {relayStatus?.connected ? "Connected" : "Disconnected"}
                  </p>
                  {relayStatus?.connected && relayStatus.clients > 0 && (
                    <p className="text-muted-foreground text-xs">
                      {relayStatus.clients} {relayStatus.clients === 1 ? "client" : "clients"}{" "}
                      connected
                    </p>
                  )}
                </div>
              </div>
              {accessUrl && (
                <div className="border-border/50 flex items-center justify-between gap-2 border-t pt-3">
                  <div className="min-w-0">
                    <p className="text-muted-foreground text-xs">Access URL</p>
                    <p className="truncate font-mono text-sm">{accessUrl}</p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 shrink-0"
                    onClick={() => copyToClipboard(accessUrl, "URL")}
                  >
                    <Copy className="size-3.5" />
                  </Button>
                </div>
              )}
            </div>
          </div>

          <Separator />

          {/* Pairing code */}
          <div className="space-y-3">
            <h4 className="text-sm font-medium">Pair a Device</h4>
            <p className="text-muted-foreground text-base">
              {accessUrl
                ? "Open the access URL above on your phone or browser, then enter the pairing code."
                : "Generate a code, then enter it on your phone or browser to connect."}
            </p>

            {pairCode ? (
              <div className="space-y-2">
                <div className="bg-muted/50 flex items-center justify-between rounded-lg px-4 py-4">
                  <span className="font-mono text-2xl font-bold tracking-wider">{pairCode}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    onClick={() => copyToClipboard(pairCode, "Code")}
                  >
                    <Copy className="size-3.5" />
                  </Button>
                </div>
                <p className="text-muted-foreground text-sm">
                  Expires in {Math.floor(countdown / 60)}:{String(countdown % 60).padStart(2, "0")}
                </p>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={handleGenerateCode}
                disabled={generateCodeMutation.isPending}
              >
                {generateCodeMutation.isPending ? (
                  <RefreshCw className="mr-2 size-3.5 animate-spin" />
                ) : null}
                Generate Pairing Code
              </Button>
            )}
          </div>

          <Separator />

          {/* Paired devices */}
          <div className="space-y-3">
            <h4 className="text-sm font-medium">
              Paired Devices
              {devices.length > 0 && (
                <Badge variant="outline" className="ml-2 text-xs">
                  {devices.length}
                </Badge>
              )}
            </h4>

            {devices.length === 0 ? (
              <p className="text-muted-foreground text-sm">No devices paired yet.</p>
            ) : (
              <div className="space-y-2">
                {devices.map((device) => {
                  const DeviceIcon = getDeviceIcon(device.user_agent);
                  return (
                    <div
                      key={device.id}
                      className="bg-muted/50 flex items-center justify-between rounded-lg px-4 py-3"
                    >
                      <div className="flex items-center gap-3">
                        <DeviceIcon className="text-muted-foreground size-4 shrink-0" />
                        <div>
                          <p className="text-sm font-medium">{device.name}</p>
                          <p className="text-muted-foreground text-xs">
                            Last seen {timeAgo(device.last_seen_at)}
                            {device.ip_address ? ` · ${device.ip_address}` : ""}
                          </p>
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-muted-foreground hover:text-destructive size-8"
                        onClick={() => handleRevokeDevice(device)}
                        disabled={revokeDeviceMutation.isPending}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
