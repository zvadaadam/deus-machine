import { useState, useRef, useEffect, useCallback } from "react";
import { formatTimeAgo } from "@/shared/lib/formatters";
import { QRCodeSVG } from "qrcode.react";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { Copy, Trash2, Smartphone, Monitor, Plus, Check, Link2 } from "lucide-react";
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

function getDeviceIcon(ua: string | null) {
  if (!ua) return Monitor;
  const lower = ua.toLowerCase();
  if (lower.includes("mobile") || lower.includes("iphone") || lower.includes("android")) {
    return Smartphone;
  }
  return Monitor;
}

/** Build the full pairing URL for QR code. */
function buildPairUrl(accessUrl: string, code: string): string {
  // accessUrl is like https://app.deusmachine.ai/connect/{serverId}
  // Append ?pair=SOFT+TIGER (URL-encode the space as +)
  const encodedCode = code.replace(/ /g, "+");
  return `${accessUrl}?pair=${encodedCode}`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/**
 * Portal URL card with connection status.
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
            connected
              ? "bg-success shadow-[0_0_6px_oklch(0.53_0.16_155/0.35)]"
              : "bg-destructive/60"
          }`}
        />
        <span className="text-muted-foreground text-xs font-medium">
          {connected ? "Connected" : "Connecting..."}
        </span>
        {connected && clients > 0 && (
          <span className="text-muted-foreground/70 text-[11px]">
            &middot; {clients} {clients === 1 ? "device" : "devices"} online
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
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(url);
              toast.success("URL copied");
            } catch {
              toast.error("Couldn't copy the URL");
            }
          }}
          title="Copy URL"
        >
          <Copy className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

/**
 * Connect Device Dialog -- shows QR code + code + countdown.
 * Code state is owned by the parent so it survives close/reopen.
 */
function ConnectDeviceDialog({
  open,
  onOpenChange,
  accessUrl,
  pairCode,
  countdown,
  isGenerating,
  onGenerate,
  devices,
  isDevicesLoaded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accessUrl: string | null;
  pairCode: string | null;
  countdown: number;
  isGenerating: boolean;
  onGenerate: () => void;
  devices: PairedDevice[];
  isDevicesLoaded: boolean;
}) {
  const [prevDeviceIds, setPrevDeviceIds] = useState<Set<string>>(
    () => new Set(devices.map((d) => d.id))
  );
  const [showSuccess, setShowSuccess] = useState(false);

  // Keep a stable ref of onOpenChange to avoid stale closures in setTimeout
  const onOpenChangeRef = useRef(onOpenChange);
  useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  }, [onOpenChange]);

  // Generate code on first open if none exists
  useEffect(() => {
    if (open && !pairCode && !isGenerating) {
      onGenerate();
    }
    if (!open) {
      setShowSuccess(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Detect successful pairing by comparing device IDs.
  // Gate on isDevicesLoaded to prevent false positives when the query resolves
  // from [] to existing devices after the dialog opens.
  useEffect(() => {
    const currentIds = new Set(devices.map((d) => d.id));

    if (!isDevicesLoaded) {
      // Query hasn't resolved yet — just update the baseline, don't detect
      setPrevDeviceIds(currentIds);
      return;
    }

    const hasNewDevice = devices.some((d) => !prevDeviceIds.has(d.id));

    if (open && hasNewDevice) {
      setShowSuccess(true);
      const timer = setTimeout(() => onOpenChangeRef.current(false), 2000);
      setPrevDeviceIds(currentIds);
      return () => clearTimeout(timer);
    }
    setPrevDeviceIds(currentIds);
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices, open, isDevicesLoaded]);

  const pairUrl = accessUrl && pairCode ? buildPairUrl(accessUrl, pairCode) : null;
  const minutes = Math.floor(countdown / 60);
  const isExpiringSoon = countdown > 0 && countdown < 120;

  async function handleCopyCode() {
    if (!pairCode) return;
    try {
      await navigator.clipboard.writeText(pairCode);
      toast.success("Code copied");
    } catch {
      toast.error("Couldn't copy the code");
    }
  }

  async function handleCopyLink() {
    if (!pairUrl) return;
    try {
      await navigator.clipboard.writeText(pairUrl);
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy the link");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {showSuccess ? (
          <div className="flex flex-col items-center gap-4 py-8">
            <div className="bg-success/10 flex size-16 items-center justify-center rounded-full">
              <Check className="text-success size-8" />
            </div>
            <div className="text-center">
              <DialogTitle className="text-lg font-semibold">Device Connected</DialogTitle>
              <DialogDescription className="text-muted-foreground mt-1 text-sm">
                You can now access your workspaces from this device.
              </DialogDescription>
            </div>
          </div>
        ) : (
          <>
            <DialogHeader className="text-center">
              <DialogTitle>Connect a Device</DialogTitle>
              <DialogDescription>
                Scan the QR code or enter the code on your other device.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col items-center gap-5 pt-2">
              {/* QR Code -- hero element */}
              {pairUrl ? (
                <div className="rounded-xl bg-white p-3">
                  <QRCodeSVG value={pairUrl} size={180} level="M" />
                </div>
              ) : accessUrl ? (
                <div className="bg-muted/40 flex size-[204px] items-center justify-center rounded-xl">
                  <span className="text-muted-foreground text-sm">Generating...</span>
                </div>
              ) : (
                <div className="bg-muted/40 flex size-[204px] items-center justify-center rounded-xl">
                  <span className="text-muted-foreground px-4 text-center text-sm">
                    Waiting for connection...
                  </span>
                </div>
              )}

              {/* Code display */}
              {pairCode ? (
                <p className="font-mono text-2xl font-bold tracking-wide">{pairCode}</p>
              ) : (
                <div className="bg-muted/40 h-8 w-40 animate-pulse rounded" />
              )}

              {/* Action buttons — Copy Link is primary (higher conversion for web sharing) */}
              <div className="flex gap-2">
                <Button variant="default" size="sm" onClick={handleCopyLink} disabled={!pairUrl}>
                  <Link2 className="mr-1.5 size-3.5" />
                  Copy Link
                </Button>
                <Button variant="outline" size="sm" onClick={handleCopyCode} disabled={!pairCode}>
                  <Copy className="mr-1.5 size-3.5" />
                  Copy Code
                </Button>
              </div>

              {/* Countdown + regenerate */}
              {countdown > 0 ? (
                <p
                  className={`text-xs ${isExpiringSoon ? "text-warning" : "text-muted-foreground"}`}
                >
                  {minutes >= 1
                    ? `Expires in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`
                    : "Expiring soon"}
                </p>
              ) : pairCode === null && !isGenerating ? (
                <Button variant="ghost" size="sm" onClick={onGenerate}>
                  Generate new code
                </Button>
              ) : null}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Connected devices list with remove action per device.
 */
function DevicesList({
  devices,
  onRemove,
  isRemoving,
}: {
  devices: PairedDevice[];
  onRemove: (device: PairedDevice) => void;
  isRemoving: boolean;
}) {
  if (devices.length === 0) {
    return <p className="text-muted-foreground py-0.5 text-sm">No devices connected yet.</p>;
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
                  {formatTimeAgo(device.last_seen_at)}
                  {device.ip_address ? ` \u00b7 ${device.ip_address}` : ""}
                </p>
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-destructive size-7"
              onClick={() => onRemove(device)}
              disabled={isRemoving}
              title={`Remove ${device.name}`}
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
 *   1. Toggle + hero portal card (URL, status, copy)
 *   2. "+ Connect a Device" button that opens a dialog with QR + code
 *   3. Connected devices list
 */
export function AccessSection({ settings, saveSetting }: SettingsSectionProps) {
  const enabled = settings.remote_access_enabled === true;

  // Remote access queries -- only active when enabled
  const devicesQuery = usePairedDevices(enabled);
  const relayQuery = useRelayStatus(enabled);
  const generateCodeMutation = useGeneratePairCode();
  const revokeDeviceMutation = useRevokeDevice();

  // Dialog state
  const [dialogOpen, setDialogOpen] = useState(false);

  // Code state -- lives here so it survives dialog close/reopen
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [codeExpiresAt, setCodeExpiresAt] = useState(0);
  const [countdown, setCountdown] = useState(0);

  // Countdown timer -- runs regardless of dialog open state
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

  async function handleGenerateCode() {
    try {
      const result = await generateCodeMutation.mutateAsync();
      setPairCode(result.code);
      setCodeExpiresAt(Date.now() + result.expires_in_seconds * 1000);
    } catch {
      toast.error("Couldn't generate a code. Try again.");
    }
  }

  // -- Handlers --

  const handleToggle = useCallback(
    async (on: boolean) => {
      const ok = await saveSetting("remote_access_enabled", on);
      if (ok) {
        toast.success(on ? "Device connections enabled" : "Device connections disabled");
      }
    },
    [saveSetting]
  );

  async function handleRemoveDevice(device: PairedDevice) {
    try {
      await revokeDeviceMutation.mutateAsync(device.id);
      toast.success(`Removed "${device.name}"`);
    } catch {
      toast.error("Couldn't remove device. Try again.");
    }
  }

  // -- Derived values --

  const relayStatus = relayQuery.data;
  const devices = devicesQuery.data ?? [];

  // Derive web app URL from relay WebSocket URL
  // wss://relay.deusmachine.ai -> https://app.deusmachine.ai/connect/{serverId}
  const accessUrl = (() => {
    if (!relayStatus?.relayUrl || !relayStatus.serverId) return null;
    try {
      const url = new URL(relayStatus.relayUrl);
      const host = url.hostname;
      const domain = host.replace(/^relay\./, "app.");
      return `https://${domain}/connect/${relayStatus.serverId}`;
    } catch {
      return null;
    }
  })();

  // -- Render --

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h3 className="text-base font-semibold">Remote Access</h3>
        <p className="text-muted-foreground mt-1 text-sm">
          Access your workspaces from your phone or another computer.
        </p>
      </div>

      {/* Master toggle */}
      <div className="flex items-center justify-between">
        <div>
          <Label htmlFor="remote-access-toggle" className="text-sm">
            Enable remote access
          </Label>
          <p className="text-muted-foreground text-xs">
            Allow other devices to connect to this machine.
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

          {/* Disconnected state without URL */}
          {relayStatus && !accessUrl && (
            <div className="bg-muted/30 flex items-center gap-2.5 rounded-lg px-4 py-3">
              <span className="bg-warning size-[7px] shrink-0 rounded-full" />
              <span className="text-muted-foreground text-sm">
                {relayStatus.connected ? "Setting up..." : "Connecting..."}
              </span>
            </div>
          )}

          <Separator />

          {/* Connect a Device button */}
          <div className="space-y-3">
            <Button variant="outline" size="sm" onClick={() => setDialogOpen(true)}>
              <Plus className="mr-1.5 size-3.5" />
              Connect a Device
            </Button>
          </div>

          {/* Connect Device Dialog */}
          <ConnectDeviceDialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            accessUrl={accessUrl}
            pairCode={pairCode}
            countdown={countdown}
            isGenerating={generateCodeMutation.isPending}
            onGenerate={handleGenerateCode}
            devices={devices}
            isDevicesLoaded={devicesQuery.isFetched}
          />

          <Separator />

          {/* Connected devices */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <h4 className="text-sm font-medium">Connected Devices</h4>
              {devices.length > 0 && (
                <Badge variant="secondary" className="text-[11px]">
                  {devices.length}
                </Badge>
              )}
            </div>
            <DevicesList
              devices={devices}
              onRemove={handleRemoveDevice}
              isRemoving={revokeDeviceMutation.isPending}
            />
          </div>
        </>
      )}
    </div>
  );
}
