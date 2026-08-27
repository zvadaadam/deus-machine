import { Globe } from "lucide-react";

/**
 * Honest placeholder for the Browser tab on a cloud computer. The in-app
 * browser previews a dev server at localhost:PORT — which only reaches a LOCAL
 * workspace. A cloud computer's ports live in the sandbox and need a tunnel
 * (port-forward) we haven't built yet, so mounting BrowserPanel here would just
 * load the wrong localhost. Say so plainly until the tunnel ships.
 */
export function CloudBrowserUnavailable() {
  return (
    <div className="bg-bg-base flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="bg-bg-muted/30 flex h-10 w-10 items-center justify-center rounded-xl">
        <Globe className="text-text-muted/60 h-5 w-5" aria-hidden="true" />
      </div>
      <p className="text-text-secondary text-sm font-medium">
        Preview is coming to cloud computers
      </p>
      <p className="text-text-muted max-w-xs text-xs">
        The in-app browser previews a dev server running on your computer. Reaching a cloud
        computer's ports needs a secure tunnel we're still building — for now, use the browser on a
        local workspace.
      </p>
    </div>
  );
}
