import { Globe } from "lucide-react";

/**
 * The Browser tab on a cloud computer BEFORE the platform has reported the
 * sandbox's public address (it arrives with the running workspace state and
 * the session snapshot). Once known, ContentView mounts CloudPreviewPanel
 * instead — this is the honest interim, not a "coming soon".
 */
export function CloudBrowserUnavailable() {
  return (
    <div className="bg-bg-base flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="bg-bg-muted/30 flex h-10 w-10 items-center justify-center rounded-xl">
        <Globe className="text-text-muted/60 h-5 w-5" aria-hidden="true" />
      </div>
      <p className="text-text-secondary text-sm font-medium">Waiting for the computer's address</p>
      <p className="text-text-muted max-w-xs text-xs">
        The preview opens the dev server running inside this cloud computer. Its address arrives
        once the sandbox is running — send a message to wake it if it's asleep.
      </p>
    </div>
  );
}
