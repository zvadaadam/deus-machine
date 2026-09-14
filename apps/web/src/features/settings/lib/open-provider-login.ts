import { toast } from "sonner";

/** Desktop resolves the bundled CLI; a browser offers the same command to copy. */
export async function openProviderLogin(provider: "claude" | "codex"): Promise<void> {
  const command = provider === "claude" ? "claude auth login" : "codex login";
  try {
    if (window.electronAPI?.openTerminal) {
      const result = await window.electronAPI.openTerminal(command);
      if (result === "opened") return;
    } else {
      await navigator.clipboard.writeText(command);
    }
    toast.success("Copied sign-in command", {
      description: "Paste it into your terminal to sign in.",
    });
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Couldn’t start provider sign-in");
  }
}
