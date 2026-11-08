/**
 * ConnectPage -- the computers this Deus account can reach through the relay.
 *
 * A computer appears here once Deus on it is signed in to the same account
 * with Remote access on. Opening one goes to /s/{id}; the first visit from a
 * browser asks the computer to approve it, later visits connect directly.
 * /connect/$serverId (an old shared link) redirects straight to the computer.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Monitor, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { formatTimeAgo } from "@/shared/lib/formatters";
import { onDeviceAuthChange } from "@/platform/ws/device-auth";
import {
  listMachines,
  readRelayAccount,
  machineFingerprint,
  removeMachine,
  RelayTicketError,
  expireRelayAccount,
  type RemoteMachine,
} from "@/platform/ws/relay-access";
import { beginWebCloudLogin } from "@/features/session/cloud/webCloudDirectConfig";

type Listing =
  | { status: "loading" }
  | { status: "ready"; machines: RemoteMachine[] }
  | { status: "error"; message: string };

function useAccountBearer(): string | null {
  return useSyncExternalStore(
    onDeviceAuthChange,
    () => readRelayAccount()?.bearer ?? null,
    () => null
  );
}

export function ConnectPage() {
  const navigate = useNavigate();
  const bearer = useAccountBearer();
  const [listing, setListing] = useState<Listing>({ status: "loading" });
  const [removing, setRemoving] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const account = readRelayAccount();
    if (!account) return;
    let current = true;
    setListing({ status: "loading" });
    listMachines(account).then(
      (machines) => current && setListing({ status: "ready", machines }),
      (error: unknown) => {
        if (!current) return;
        if (error instanceof RelayTicketError && error.kind === "expired") {
          expireRelayAccount(account);
          return;
        }
        setListing({
          status: "error",
          message: error instanceof Error ? error.message : "Couldn't load your computers.",
        });
      }
    );
    return () => {
      current = false;
    };
  }, [bearer, revision]);

  const remove = useCallback(async (machine: RemoteMachine) => {
    const account = readRelayAccount();
    if (!account) return;
    setRemoving(machine.id);
    try {
      await removeMachine(account, machine.id);
      setListing((previous) =>
        previous.status === "ready"
          ? { status: "ready", machines: previous.machines.filter((m) => m.id !== machine.id) }
          : previous
      );
      toast.success(`Removed "${machine.name}"`);
    } catch {
      toast.error("Couldn't remove the computer. Try again.");
    } finally {
      setRemoving(null);
    }
  }, []);

  return (
    <div className="bg-background flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-tight">Your computers</h1>
          <p className="text-muted-foreground mt-2 text-sm">
            {bearer
              ? "Computers signed in to this Deus account with Remote access on."
              : "Sign in with the Deus account your computer uses."}
          </p>
        </div>

        {!bearer ? (
          <Button className="w-full" onClick={() => beginWebCloudLogin("/connect")}>
            Sign in
          </Button>
        ) : listing.status === "loading" ? (
          <div className="space-y-2" aria-busy="true">
            {[0, 1].map((row) => (
              <div key={row} className="bg-muted/40 h-14 animate-pulse rounded-lg" />
            ))}
          </div>
        ) : listing.status === "error" ? (
          <div className="space-y-3 text-center">
            <p className="text-destructive text-sm" role="alert">
              {listing.message}
            </p>
            <Button variant="outline" size="sm" onClick={() => setRevision((n) => n + 1)}>
              Try again
            </Button>
          </div>
        ) : listing.machines.length === 0 ? (
          <p className="text-muted-foreground bg-muted/30 rounded-lg px-4 py-3 text-center text-sm">
            No computers yet. In Deus on your computer, open Settings → Remote access and turn it
            on.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {listing.machines.map((machine) => (
              <li
                key={machine.id}
                className="bg-muted/30 hover:bg-muted/50 flex items-center gap-1 rounded-lg pr-2"
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-3 px-4 py-2.5 text-left"
                  onClick={() => navigate({ to: "/s/$serverId", params: { serverId: machine.id } })}
                >
                  <Monitor className="text-muted-foreground size-4 shrink-0" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{machine.name}</span>
                    <span className="text-muted-foreground block text-xs">
                      {machine.last_seen_at
                        ? `Connected ${formatTimeAgo(machine.last_seen_at)}`
                        : "Not connected yet"}
                      <span className="font-mono"> · {machineFingerprint(machine.id)}</span>
                    </span>
                  </span>
                </button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => void remove(machine)}
                  disabled={removing === machine.id}
                  title={`Remove ${machine.name}`}
                  aria-label={`Remove ${machine.name}`}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
