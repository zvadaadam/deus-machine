import { useState, useRef, useEffect, useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { formatTimeAgo } from "@/shared/lib/formatters";
import { QRCodeSVG } from "qrcode.react";
import { capabilities, native } from "@/platform";
import { queryKeys } from "@/shared/api/queryKeys";
import { useDeusCloudSession } from "@/shared/hooks/useDeusCloudSession";
import { pairingLink } from "@/features/auth/lib/pairing-link";
import { deviceDisplayName } from "@/features/auth/lib/device-name";
import { machineFingerprint } from "@/platform/ws/relay-access";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { Copy, Smartphone, Monitor, Plus, Check, Link2, LogIn } from "lucide-react";
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

function getDeviceIcon(device: { name: string; user_agent: string | null }) {
  const text = `${device.user_agent ?? ""} ${device.name}`.toLowerCase();
  return /mobile|iphone|android phone|\bphone\b/.test(text) ? Smartphone : Monitor;
}

/**
 * The web app's origin for this relay: wss://relay.deusmachine.ai serves
 * https://deusmachine.ai (app.deusmachine.ai remains a path-preserving alias).
 */
function appOriginFor(relayUrl: string): string | null {
  const configured = import.meta.env.VITE_DEUS_APP_URL as string | undefined;
  if (configured) return configured.replace(/\/$/, "");
  try {
    return `https://${new URL(relayUrl).hostname.replace(/^relay\./, "")}`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Remote access belongs to a Deus account: the relay serves this computer to it only. */
function SignInCard() {
  const queryClient = useQueryClient();
  const signIn = useMutation({
    mutationFn: () => native.deusCloud.startLogin(),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.deusCloud.session, result.session);
      if (!result.success) toast.error(result.error ?? "Sign-in did not complete");
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : "Sign-in failed"),
  });
  return (
    <div className="border-border/60 bg-muted/30 flex items-center justify-between gap-4 rounded-xl border px-4 py-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">Sign in to use remote access</p>
        <p className="text-muted-foreground text-xs">
          Your other devices reach this computer through your Deus account.
        </p>
      </div>
      <Button size="sm" onClick={() => signIn.mutate()} disabled={signIn.isPending}>
        <LogIn className="mr-1.5 size-3.5" />
        Sign in
      </Button>
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
  appOrigin,
  serverId,
  serverName,
  pairCode,
  countdown,
  isGenerating,
  onGenerate,
  onCodeUsed,
  devices,
  isDevicesLoaded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appOrigin: string | null;
  serverId: string | null;
  serverName: string | null;
  pairCode: string | null;
  countdown: number;
  isGenerating: boolean;
  onGenerate: () => void;
  /** A code approves one device: once a device pairs, the shown code is spent. */
  onCodeUsed: () => void;
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
      onCodeUsed();
      const timer = setTimeout(() => onOpenChangeRef.current(false), 2000);
      setPrevDeviceIds(currentIds);
      return () => clearTimeout(timer);
    }
    setPrevDeviceIds(currentIds);
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices, open, isDevicesLoaded]);

  const pairUrl =
    appOrigin && serverId && pairCode ? pairingLink(appOrigin, serverId, pairCode) : null;
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
              <DialogTitle>Add a device</DialogTitle>
              <DialogDescription>
                Scan the QR code, signed in to the same Deus account, or enter the code on your
                other device. You approve each device once.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col items-center gap-5 pt-2">
              {/* QR Code -- hero element */}
              {pairUrl ? (
                <div className="rounded-xl bg-white p-3">
                  <QRCodeSVG value={pairUrl} size={180} level="M" />
                </div>
              ) : serverId ? (
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
              {/* The other device names the computer it pairs with; they must match. */}
              {serverId && (
                <p className="text-muted-foreground -mt-3 text-xs">
                  For {serverName ?? "this computer"}
                  <span className="font-mono"> · {machineFingerprint(serverId)}</span>
                </p>
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
 * The devices this computer approved, each with its live state and a way to
 * revoke it.
 */
function DevicesList({
  devices,
  onRevoke,
}: {
  devices: PairedDevice[];
  onRevoke: (device: PairedDevice) => void;
}) {
  if (devices.length === 0) {
    return (
      <p className="text-muted-foreground py-0.5 text-sm">
        No devices yet. Add one to control this computer from your phone.
      </p>
    );
  }

  return (
    <div className="space-y-1.5">
      {devices.map((device) => {
        const DeviceIcon = getDeviceIcon(device);
        const name = deviceDisplayName(device);
        return (
          <div
            key={device.id}
            className="bg-muted/30 flex items-center justify-between gap-3 rounded-lg px-4 py-2.5"
          >
            <div className="flex min-w-0 items-center gap-3">
              <DeviceIcon className="text-muted-foreground size-4 shrink-0" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{name}</p>
                <p className="text-muted-foreground flex items-center gap-1.5 truncate text-xs">
                  {device.connected ? (
                    <>
                      <span className="bg-success size-1.5 shrink-0 rounded-full" />
                      Connected
                    </>
                  ) : (
                    `Last connected ${formatTimeAgo(device.last_seen_at)}`
                  )}
                  {device.account_id
                    ? ""
                    : ` \u00b7 ${device.ip_address ? `${device.ip_address} \u00b7 ` : ""}Local network only`}
                </p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive shrink-0"
              onClick={() => onRevoke(device)}
            >
              Revoke access
            </Button>
          </div>
        );
      })}
    </div>
  );
}

/** Revoking disconnects the device; it needs approving again to come back. */
function RevokeDeviceDialog({
  device,
  pending,
  onCancel,
  onConfirm,
}: {
  device: PairedDevice | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={device !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Revoke access?</DialogTitle>
          <DialogDescription>
            {device ? deviceDisplayName(device) : "This device"} is disconnected and needs your
            approval again to reconnect.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" onClick={onConfirm} disabled={pending}>
            Revoke access
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Main Section
// ---------------------------------------------------------------------------

/**
 * Remote access settings: the switch, keeping the computer awake for a
 * connected device, and the devices it approved (Add opens the QR + code
 * dialog). Status shows only when something is wrong; devices reach this
 * computer through the account, so no address is shown.
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

  // A paired device consumed the code; reopening the dialog generates a new one.
  const handleCodeUsed = useCallback(() => {
    setPairCode(null);
    setCodeExpiresAt(0);
    setCountdown(0);
  }, []);

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

  const [revoking, setRevoking] = useState<PairedDevice | null>(null);

  async function handleRevokeDevice() {
    if (!revoking) return;
    const name = deviceDisplayName(revoking);
    try {
      await revokeDeviceMutation.mutateAsync(revoking.id);
      toast.success(`Revoked access for ${name}`);
      setRevoking(null);
    } catch {
      toast.error("Couldn't revoke access. Try again.");
    }
  }

  // -- Derived values --

  const relayStatus = relayQuery.data;
  const devices = devicesQuery.data ?? [];
  // The backend reports whether it holds an account session; the desktop's
  // session query only names the account.
  const session = useDeusCloudSession().data;
  const signedOut = relayStatus?.state === "signed_out";
  const removed = relayStatus?.state === "removed";
  const appOrigin = relayStatus?.relayUrl ? appOriginFor(relayStatus.relayUrl) : null;
  const keepAwake = settings.remote_keep_awake !== false;
  const thisComputer = /Mac/.test(navigator.userAgent) ? "this Mac" : "this computer";

  // -- Render --

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h3 className="text-base font-semibold">Remote Access</h3>
        <p className="text-muted-foreground mt-1 text-sm">
          Control this computer from your phone or another computer.
        </p>
      </div>

      {/* Master toggle */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <Label htmlFor="remote-access-toggle" className="text-sm">
            Allow remote access
          </Label>
          <p className="text-muted-foreground text-xs">
            Devices signed in to your Deus account connect after you approve them once.
          </p>
        </div>
        <Switch id="remote-access-toggle" checked={enabled} onCheckedChange={handleToggle} />
      </div>

      {/* ----- Everything below is gated on the toggle ----- */}

      {enabled && (
        <>
          {signedOut && <SignInCard />}

          {removed && (
            <div className="border-border/60 bg-muted/30 flex items-center justify-between gap-4 rounded-xl border px-4 py-4">
              <p className="text-muted-foreground text-xs">{relayStatus?.error}</p>
              {/* Turning it on again re-adds a computer the account removed. */}
              <Button size="sm" variant="outline" onClick={() => void handleToggle(true)}>
                Add it again
              </Button>
            </div>
          )}

          {/* Status only when devices can't reach this computer right now. */}
          {!signedOut && !removed && relayStatus && !relayStatus.connected && (
            <div className="bg-muted/30 flex items-center gap-2.5 rounded-lg px-4 py-3">
              <span className="bg-warning size-[7px] shrink-0 rounded-full" />
              <span className="text-muted-foreground text-sm">
                {relayStatus.error ?? "Connecting..."}
              </span>
            </div>
          )}

          {/* A browser can't hold a computer awake; only the desktop app shows this. */}
          {capabilities.isDesktop && (
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="remote-keep-awake" className="text-sm">
                  Keep {thisComputer} awake
                </Label>
                <p className="text-muted-foreground text-xs">
                  Prevent sleep while a device is connected and {thisComputer} is plugged in.
                </p>
              </div>
              <Switch
                id="remote-keep-awake"
                checked={keepAwake}
                onCheckedChange={(on) => void saveSetting("remote_keep_awake", on)}
              />
            </div>
          )}

          {/* Approved devices */}
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <h4 className="text-sm font-medium">Devices that can control this computer</h4>
                {session?.accountEmail && (
                  <p className="text-muted-foreground truncate text-xs">
                    Signed in to {session.accountEmail}
                  </p>
                )}
              </div>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => setDialogOpen(true)}
                disabled={signedOut}
              >
                <Plus className="size-3.5" />
                Add device
              </Button>
            </div>
            <DevicesList devices={devices} onRevoke={setRevoking} />
          </div>

          {/* Add-a-device dialog */}
          <ConnectDeviceDialog
            open={dialogOpen}
            onOpenChange={setDialogOpen}
            appOrigin={appOrigin}
            serverId={relayStatus?.serverId ?? null}
            serverName={relayStatus?.serverName ?? null}
            pairCode={pairCode}
            countdown={countdown}
            isGenerating={generateCodeMutation.isPending}
            onGenerate={handleGenerateCode}
            onCodeUsed={handleCodeUsed}
            devices={devices}
            isDevicesLoaded={devicesQuery.isFetched}
          />

          <RevokeDeviceDialog
            device={revoking}
            pending={revokeDeviceMutation.isPending}
            onCancel={() => setRevoking(null)}
            onConfirm={() => void handleRevokeDevice()}
          />
        </>
      )}
    </div>
  );
}
