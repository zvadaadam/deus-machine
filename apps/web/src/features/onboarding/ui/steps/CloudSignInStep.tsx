import { useMutation, useQueryClient } from "@tanstack/react-query";
import { initialsFrom } from "@/shared/lib/formatters";
import { Cloud, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { queryKeys } from "@/shared/api/queryKeys";
import { useDeusCloudSession } from "@/shared/hooks/useDeusCloudSession";
import { startLogin } from "@/platform/native/deus-cloud";

interface CloudSignInStepProps {
  onNext: () => void;
  onBack: () => void;
}

/**
 * Deus Cloud sign-in, offered right after the intro.
 *
 * Deliberately SKIPPABLE: everything in Deus works against local git
 * worktrees without an account, and cloud workspaces are the opt-in. Making
 * this a wall would gate a working local app behind a network round-trip.
 */
export function CloudSignInStep({ onNext, onBack }: CloudSignInStepProps) {
  const queryClient = useQueryClient();

  const session = useDeusCloudSession();

  const signIn = useMutation({
    mutationFn: startLogin,
    onSuccess: async (result) => {
      if (!result.success) {
        toast.error(result.error ?? "Deus Cloud sign-in did not complete");
        return;
      }
      queryClient.setQueryData(queryKeys.deusCloud.session, result.session);
      await queryClient.invalidateQueries({ queryKey: ["settings", "cloud"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Sign-in failed"),
  });

  const data = session.data;
  const signedIn = data?.signedIn === true;

  return (
    <div className="flex w-full max-w-md flex-col gap-6">
      <div className="space-y-2">
        <h2 className="text-onboarding-foreground text-2xl font-semibold">Sign in to Deus Cloud</h2>
        <p className="text-onboarding-foreground/50 text-sm">
          Run agents on cloud computers and pick work up from your phone. You can do this later —
          local workspaces work without an account.
        </p>
      </div>

      <div className="bg-onboarding-foreground/5 flex items-center gap-3 rounded-xl px-4 py-3">
        <div className="bg-onboarding-foreground/10 flex size-10 shrink-0 items-center justify-center rounded-full">
          {signedIn ? (
            <span className="text-onboarding-foreground text-xs font-semibold">
              {initialsFrom(data?.accountName, data?.accountEmail) ?? "DC"}
            </span>
          ) : (
            <Cloud className="text-onboarding-foreground/50 size-5" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-onboarding-foreground truncate text-sm font-medium">
            {signedIn ? (data?.accountName ?? "Signed in") : "Not signed in"}
          </p>
          <p className="text-onboarding-foreground/50 truncate text-xs">
            {signedIn
              ? (data?.accountEmail ?? data?.accountId)
              : signIn.isPending
                ? "Complete sign-in in your browser"
                : "Opens your browser to authenticate"}
          </p>
        </div>
        {!signedIn && (
          <button
            onClick={() => signIn.mutate()}
            disabled={signIn.isPending}
            className="control-interaction bg-onboarding-foreground/10 text-onboarding-foreground/80 hover:bg-onboarding-foreground/15 hover:text-onboarding-foreground flex shrink-0 items-center gap-2 rounded-lg px-4 py-2 text-sm font-normal"
          >
            {signIn.isPending && <Loader2 className="size-3.5 animate-spin" />}
            {signIn.isPending ? "Waiting" : "Sign in"}
          </button>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="control-interaction text-onboarding-foreground/50 hover:text-onboarding-foreground/80 rounded-lg px-6 py-2.5 text-sm font-normal"
        >
          Back
        </button>
        <div className="flex-1" />
        {/* Skip is meaningless once signed in — one primary action, not two. */}
        {!signedIn && (
          <button
            onClick={onNext}
            className="control-interaction bg-onboarding-foreground/10 text-onboarding-foreground/70 hover:bg-onboarding-foreground/15 hover:text-onboarding-foreground rounded-lg px-6 py-2.5 text-sm font-normal"
          >
            Skip
          </button>
        )}
        {signedIn && (
          <button
            onClick={onNext}
            className="control-interaction bg-onboarding-foreground text-onboarding-contrast hover:bg-onboarding-foreground/90 active:bg-onboarding-foreground/80 rounded-lg px-6 py-2.5 text-sm font-medium"
          >
            Continue
          </button>
        )}
      </div>
    </div>
  );
}
