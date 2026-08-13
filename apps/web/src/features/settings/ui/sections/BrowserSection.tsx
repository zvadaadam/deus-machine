import { useState } from "react";
import { CheckCircle2, Globe, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { native } from "@/platform";
import { getErrorMessage } from "@shared/lib/errors";
import {
  useBrowserProfiles,
  useConnectBrowserProfile,
  useClearBrowserSession,
  type BrowserProfile,
} from "../../api/browser-import.queries";

function profileKey(p: BrowserProfile): string {
  return `${p.browserId}:${p.profileDir}`;
}

function initials(p: BrowserProfile): string {
  const source = p.name || p.email || p.browserName;
  const parts = source.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

function formatLastUsed(ms: number | null): string | null {
  if (!ms) return null;
  const diff = Date.now() - ms;
  if (diff < 0) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "used just now";
  if (mins < 60) return `used ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `used ${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `used ${days}d ago`;
  return `used ${Math.floor(days / 7)}w ago`;
}

// Cookies persist in the shared session, so the connected badge must survive
// navigation/restart. We can't attribute session cookies back to a profile, so
// this is a best-effort record of which profiles were imported; the Clear
// action resets it.
const CONNECTED_KEY = "deus.browser.connectedProfiles";

function loadConnected(): Set<string> {
  try {
    const raw = localStorage.getItem(CONNECTED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveConnected(keys: Set<string>): void {
  try {
    localStorage.setItem(CONNECTED_KEY, JSON.stringify([...keys]));
  } catch {
    // localStorage unavailable — badges just won't persist.
  }
}

export function BrowserSection() {
  const profiles = useBrowserProfiles();
  const connect = useConnectBrowserProfile();
  const clearSession = useClearBrowserSession();
  const [connectingKey, setConnectingKey] = useState<string | null>(null);
  const [connected, setConnected] = useState<Set<string>>(loadConnected);

  async function onConnect(profile: BrowserProfile): Promise<void> {
    const key = profileKey(profile);
    setConnectingKey(key);
    try {
      const result = await connect.mutateAsync(profile);
      if (!result.success) {
        toast.error(result.error ?? "Could not import cookies");
        return;
      }
      if (result.imported === 0) {
        // Nothing landed (no cookies, or every write was rejected) — don't
        // report a session that wasn't actually changed.
        toast.warning(
          `No cookies were imported from ${profile.name || profile.browserName}` +
            (result.failed ? ` (${result.failed} rejected)` : "")
        );
        return;
      }
      setConnected((prev) => {
        const next = new Set(prev).add(key);
        saveConnected(next);
        return next;
      });
      toast.success(
        `Imported ${result.imported} cookie${result.imported === 1 ? "" : "s"} from ${
          profile.name || profile.browserName
        }`
      );
    } catch (error) {
      // Surfaces a Keychain denial/cancel or a decrypt failure.
      toast.error(getErrorMessage(error));
    } finally {
      setConnectingKey(null);
    }
  }

  async function onClearData(): Promise<void> {
    const confirmed = await native.dialog.confirm(
      "Clear browser data?",
      "This signs the in-app browser out of every imported session and clears its cookies, storage, and cache. Your other browsers aren't affected."
    );
    if (!confirmed) return;
    try {
      await clearSession.mutateAsync();
      setConnected(new Set());
      saveConnected(new Set());
      toast.success("Browser data cleared");
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  }

  const list = profiles.data ?? [];

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold">Connect your browser</h3>
        <p className="text-muted-foreground mt-1 text-base">
          Import a browser profile so the agent works in the sessions you&apos;re already logged
          into. Cookies are copied into the in-app browser; your other browsers aren&apos;t changed.
        </p>
      </div>

      <div className="border-border-subtle space-y-1 rounded-lg border p-2">
        {profiles.isLoading ? (
          <div className="flex h-24 items-center justify-center">
            <Loader2 className="text-muted-foreground size-4 animate-spin" />
          </div>
        ) : profiles.isError ? (
          <div className="text-muted-foreground flex h-24 flex-col items-center justify-center gap-1 text-sm">
            <Globe className="size-5" />
            {getErrorMessage(profiles.error)}
          </div>
        ) : list.length === 0 ? (
          <div className="text-muted-foreground flex h-24 flex-col items-center justify-center gap-1 text-sm">
            <Globe className="size-5" />
            No Chromium browser profiles found on this Mac.
          </div>
        ) : (
          list.map((profile) => {
            const key = profileKey(profile);
            const isConnecting = connectingKey === key;
            const isConnected = connected.has(key);
            const lastUsed = formatLastUsed(profile.lastActiveMs);
            const subtitle =
              [profile.email, lastUsed].filter(Boolean).join(" · ") || "Local profile";
            return (
              <div
                key={key}
                className="hover:bg-foreground/[0.03] flex items-center gap-3 rounded-md p-2.5 transition-colors"
              >
                <Avatar className="size-8 shrink-0">
                  <AvatarFallback className="text-xs font-semibold">
                    {initials(profile)}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {profile.name || profile.browserName}
                    <span className="text-muted-foreground ml-1.5 text-xs font-normal">
                      {profile.browserName}
                    </span>
                  </p>
                  <p className="text-muted-foreground truncate text-xs">{subtitle}</p>
                </div>
                {isConnected ? (
                  <span className="text-success flex items-center gap-1.5 text-xs font-medium">
                    <CheckCircle2 className="size-4" />
                    Connected
                  </span>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0 gap-1.5"
                    disabled={isConnecting || connect.isPending || clearSession.isPending}
                    onClick={() => void onConnect(profile)}
                  >
                    {isConnecting && <Loader2 className="size-3.5 animate-spin" />}
                    {isConnecting ? "Connecting" : "Connect"}
                  </Button>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-xs">
          Reading cookies asks macOS for Keychain access the first time per browser.
        </p>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive gap-1.5"
            disabled={clearSession.isPending || connect.isPending}
            onClick={() => void onClearData()}
          >
            {clearSession.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Trash2 className="size-3.5" />
            )}
            Clear browser data
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5"
            disabled={profiles.isFetching}
            onClick={() => void profiles.refetch()}
          >
            <RefreshCw className={profiles.isFetching ? "size-3.5 animate-spin" : "size-3.5"} />
            Refresh
          </Button>
        </div>
      </div>
    </div>
  );
}
