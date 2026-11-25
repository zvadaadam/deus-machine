import { toast } from "sonner";

/** CLI installs requested in this window, from Settings or onboarding. */
export const requestedAgentInstalls = new Set<string>();

export function finishAgentInstall(harness: string, message?: string): void {
  if (requestedAgentInstalls.delete(harness) && message) {
    toast.error(message, { id: `cli-install-${harness}` });
  }
}
