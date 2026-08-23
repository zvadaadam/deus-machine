import { useDeusCloudSession } from "@/shared/hooks/useDeusCloudSession";
import { initialsFrom } from "@/shared/lib/formatters";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Cloud, Loader2, LogIn, LogOut } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { native } from "@/platform";
import { queryKeys } from "@/shared/api/queryKeys";

function formatAccountId(accountId: string | null): string {
  if (!accountId) return "";
  if (accountId.length <= 18) return accountId;
  return `${accountId.slice(0, 10)}...${accountId.slice(-6)}`;
}

export function AccountSection() {
  const queryClient = useQueryClient();
  // Session + the auth-changed listener live in the shared hook — a listener
  // owned by this section died when the user navigated to Cloud mid-mint.
  const session = useDeusCloudSession();

  const signInMutation = useMutation({
    mutationFn: () => native.deusCloud.startLogin(),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.deusCloud.session, result.session);
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

      {/* No expiry countdown: the session renews itself silently (rotating
          refresh) and signs out only when genuinely revoked — a ticking
          clock here promises a sign-out the app exists to prevent. */}
    </div>
  );
}
