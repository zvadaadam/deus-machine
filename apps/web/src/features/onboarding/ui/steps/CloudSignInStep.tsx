import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Cloud, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { queryKeys } from "@/shared/api/queryKeys";
import { useDeusCloudSession } from "@/shared/hooks/useDeusCloudSession";
import { startLogin } from "@/platform/native/deus-cloud";

interface CloudSignInStepProps {
  onNext: () => void;
  onBack: () => void;
}

/** "Adam Zvada" -> "AZ"; falls back to the email's first letters. */
function initialsFrom(name?: string | null, email?: string | null): string {
  const source =
    name?.trim() ||
    email
      ?.split("@")[0]
      ?.replace(/[._-]+/g, " ")
      .trim();
  if (!source) return "DC";
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
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
        <h2 className="text-2xl font-semibold text-white">Sign in to Deus Cloud</h2>
        <p className="text-sm text-white/50">
          Run agents in cloud sandboxes and pick work up from your phone. You can do this later —
          local workspaces work without an account.
        </p>
      </div>

      <div className="flex items-center gap-3 rounded-xl bg-white/5 px-4 py-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-white/10">
          {signedIn ? (
            <span className="text-xs font-semibold text-white">
              {initialsFrom(data?.accountName, data?.accountEmail)}
            </span>
          ) : (
            <Cloud className="size-5 text-white/50" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-white">
            {signedIn ? (data?.accountName ?? "Signed in") : "Not signed in"}
          </p>
          <p className="truncate text-xs text-white/50">
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
            className="flex shrink-0 items-center gap-2 rounded-xl bg-white/10 px-4 py-2 text-sm font-medium text-white/80 transition-colors duration-200 hover:bg-white/15 hover:text-white disabled:opacity-60"
          >
            {signIn.isPending && <Loader2 className="size-3.5 animate-spin" />}
            {signIn.isPending ? "Waiting" : "Sign in"}
          </button>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="rounded-xl px-6 py-2.5 text-sm font-medium text-white/50 transition-colors duration-200 hover:text-white/80"
        >
          Back
        </button>
        <div className="flex-1" />
        {/* Skip is meaningless once signed in — one primary action, not two. */}
        {!signedIn && (
          <button
            onClick={onNext}
            className="rounded-xl bg-white/10 px-6 py-2.5 text-sm font-medium text-white/70 transition-colors duration-200 hover:bg-white/15 hover:text-white"
          >
            Skip
          </button>
        )}
        {signedIn && (
          <button
            onClick={onNext}
            className="rounded-xl bg-white px-6 py-2.5 text-sm font-semibold text-black transition-transform duration-200 hover:scale-[1.02] active:scale-[0.98]"
          >
            Continue
          </button>
        )}
      </div>
    </div>
  );
}
