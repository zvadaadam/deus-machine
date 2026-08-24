import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { startLogin } from "@/platform/native/deus-cloud";

/**
 * Start the browser sign-in from anywhere a surface says "sign in first" —
 * a blocked state should BE the button, not a note pointing at another tab.
 * Cache updates ride the auth-changed broadcast (useDeusCloudSession's
 * listener), so callers only need the mutation.
 */
export function useDeusCloudSignIn() {
  return useMutation({
    mutationFn: startLogin,
    onSuccess: (result) => {
      if (!result.success) toast.error(result.error ?? "Deus Cloud sign-in did not complete");
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Sign-in failed"),
  });
}
