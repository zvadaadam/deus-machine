import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useCloudSettings } from "@/shared/hooks/useCloudSettings";
import { useDeusCloudSession } from "@/shared/hooks/useDeusCloudSession";
import { useDeusCloudSignIn } from "@/shared/hooks/useDeusCloudSignIn";
import { queryKeys } from "@/shared/api/queryKeys";
import { uiActions } from "@/shared/stores/uiStore";
import { retryProvision } from "@/platform/native/deus-cloud";
import { getErrorMessage } from "@shared/lib/errors";
import type { SettingsSection } from "@shared/types/settings";

const setupLinks: { section: SettingsSection; title: string; description: string }[] = [
  {
    section: "ai",
    title: "AI Providers",
    description: "Choose the API key or subscription your agent uses.",
  },
  {
    section: "github",
    title: "GitHub",
    description: "Give cloud workspaces access to your repositories.",
  },
  {
    section: "environment",
    title: "Environment",
    description: "Set up repository scripts and application secrets.",
  },
];

export function CloudSection() {
  const queryClient = useQueryClient();
  const status = useCloudSettings();
  const session = useDeusCloudSession();
  const signIn = useDeusCloudSignIn();
  const retry = useMutation({
    mutationFn: async () => {
      const result = await retryProvision();
      if (!result.ok) throw new Error(result.error ?? "Cloud setup failed");
    },
    onSuccess: async () => {
      toast.success("Cloud workspaces are ready to use");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.deusCloud.session }),
        queryClient.invalidateQueries({ queryKey: ["settings", "cloud"] }),
      ]);
    },
    onError: (err) => toast.error(getErrorMessage(err)),
  });
  const loading = status.isPending || session.isPending;
  const failed = status.isError || session.isError;
  const connected = status.data?.enabled === true;
  const locked = session.data?.vaultLocked === true;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-semibold">Cloud</h3>
        <p className="text-muted-foreground mt-1 text-sm">
          Run agents and development environments on a cloud computer.
        </p>
      </div>
      <div className="border-border-subtle flex flex-wrap items-center justify-between gap-4 rounded-lg border p-4">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm font-medium">
            {loading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : connected && !failed ? (
              <CheckCircle2 className="text-success size-4" />
            ) : null}
            {loading
              ? "Checking connection…"
              : failed
                ? "Couldn't check your connection"
                : connected
                  ? "Connected to Deus Cloud"
                  : "Connect to Deus Cloud"}
          </p>
          <p className="text-muted-foreground mt-1 text-sm">
            {failed
              ? "Check your connection and try again."
              : locked
                ? "Unlock your computer's keyring, then reopen Deus."
                : connected
                  ? "Your cloud workspaces are available from desktop and web."
                  : session.data?.signedIn
                    ? "You're signed in, but cloud setup didn't finish."
                    : "Sign in with your Deus account to use cloud workspaces."}
          </p>
        </div>
        {!loading &&
          (failed ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void status.refetch();
                void session.refetch();
              }}
            >
              Try again
            </Button>
          ) : !connected && !locked ? (
            session.data?.signedIn ? (
              <Button size="sm" onClick={() => retry.mutate()} disabled={retry.isPending}>
                {retry.isPending ? "Setting up…" : "Retry setup"}
              </Button>
            ) : (
              <Button size="sm" onClick={() => signIn.mutate()} disabled={signIn.isPending}>
                {signIn.isPending ? "Waiting for browser…" : "Sign in"}
              </Button>
            )
          ) : null)}
      </div>
      <div className="divide-border-subtle divide-y">
        {setupLinks.map((link) => (
          <div key={link.section} className="flex items-center justify-between gap-4 py-4">
            <div>
              <h4 className="text-sm font-medium">{link.title}</h4>
              <p className="text-muted-foreground mt-1 text-sm">{link.description}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => uiActions.setActiveSettingsSection(link.section)}
            >
              Manage
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
