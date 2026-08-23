import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Cloud, Loader2, LogIn, LogOut } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { native } from "@/platform";
import { queryKeys } from "@/shared/api/queryKeys";

function formatAccountId(accountId: string | null): string {
  if (!accountId) return "";
  if (accountId.length <= 18) return accountId;
  return `${accountId.slice(0, 10)}...${accountId.slice(-6)}`;
}

function formatExpiry(expiresAt: string): string {
  const ms = Date.parse(expiresAt) - Date.now();
  if (ms <= 0) return "Expired";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `Expires in ${minutes || 1}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `Expires in ${hours}h`;
  return `Expires in ${Math.floor(hours / 24)}d`;
}

/** "Adam Zvada" -> "AZ"; falls back to the email's first letters. */
function initialsFrom(name?: string | null, email?: string | null): string | null {
  const source =
    name?.trim() ||
    email
      ?.split("@")[0]
      ?.replace(/[._-]+/g, " ")
      .trim();
  if (!source) return null;
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

export function AccountSection() {
  const queryClient = useQueryClient();
  const session = useQuery({
    queryKey: queryKeys.deusCloud.session,
    queryFn: () => native.deusCloud.getSession(),
    staleTime: 60_000,
  });

  useEffect(() => {
    return native.deusCloud.onAuthChanged((nextSession) => {
      queryClient.setQueryData(queryKeys.deusCloud.session, nextSession);
      // The mint + credentials push finish AFTER login resolves and announce
      // themselves through this broadcast — without the invalidation the
      // Cloud section keeps "no platform key" for its whole 30s window.
      void queryClient.invalidateQueries({ queryKey: ["settings", "cloud"] });
    });
  }, [queryClient]);

  const signInMutation = useMutation({
    mutationFn: () => native.deusCloud.startLogin(),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.deusCloud.session, result.session);
      // The backend's cloud settings (`enabled`) flip on sign-in via the
      // credentials push; without this the Cloud section shows stale state
      // for its whole 30s window.
      void queryClient.invalidateQueries({ queryKey: ["settings", "cloud"] });
      if (result.success && result.session.signedIn) {
        toast.success("Signed in to Deus Cloud");
        return;
      }
      toast.error(result.error ?? "Deus Cloud sign-in did not complete");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Deus Cloud sign-in failed");
    },
  });

  const signOutMutation = useMutation({
    mutationFn: () => native.deusCloud.signOut(),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.deusCloud.session, result.session);
      void queryClient.invalidateQueries({ queryKey: ["settings", "cloud"] });
      if (result.success) {
        toast.success("Signed out of Deus Cloud");
        return;
      }
      toast.error(result.error ?? "Deus Cloud sign-out did not complete");
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Deus Cloud sign-out failed");
    },
  });

  const data = session.data;
  const busy = session.isLoading || signInMutation.isPending || signOutMutation.isPending;
  const signedIn = data?.signedIn === true;
  const accountInitials = initialsFrom(data?.accountName, data?.accountEmail);

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold">Account</h3>
        <p className="text-muted-foreground mt-1 text-base">
          Deus Cloud identity for this desktop app.
        </p>
      </div>

      <div className="border-border/60 bg-muted/20 rounded-xl border p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-lg">
              {signedIn && accountInitials ? (
                <span className="text-text-primary text-sm font-semibold">{accountInitials}</span>
              ) : (
                <Cloud className="text-muted-foreground size-5" />
              )}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="truncate text-sm font-medium">
                  {signedIn ? (data.accountName ?? "Signed in") : "Not signed in"}
                </p>
                {session.isLoading ? (
                  <Loader2 className="text-muted-foreground size-3.5 animate-spin" />
                ) : signedIn ? (
                  <CheckCircle2 className="text-success size-3.5" />
                ) : (
                  <AlertCircle className="text-muted-foreground size-3.5" />
                )}
              </div>
              {signedIn ? (
                <p className="text-muted-foreground mt-1 truncate text-sm">
                  {data.accountEmail ?? formatAccountId(data.accountId)}
                </p>
              ) : (
                <p className="text-muted-foreground mt-1 text-sm">{data?.cloudUrl}</p>
              )}
            </div>
          </div>

          {signedIn ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => signOutMutation.mutate()}
            >
              {signOutMutation.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <LogOut className="size-3.5" />
              )}
              Sign out
            </Button>
          ) : (
            <Button size="sm" disabled={busy} onClick={() => signInMutation.mutate()}>
              {signInMutation.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <LogIn className="size-3.5" />
              )}
              Sign in
            </Button>
          )}
        </div>
      </div>

      {signedIn && data.expiresAt ? (
        <>
          <Separator />
          <div className="space-y-1">
            <p className="text-sm font-medium">Session</p>
            <p className="text-muted-foreground text-sm">{formatExpiry(data.expiresAt)}</p>
          </div>
        </>
      ) : null}
    </div>
  );
}
