import type { ReactNode } from "react";
import { Globe } from "lucide-react";

/**
 * The Browser tab on a cloud workspace. The Browser is this computer's own;
 * a cloud workspace's agent works in the browser on the workspace's computer,
 * and showing that one here is not built. Pointing this computer's browser at
 * the sandbox's public address was removed: it was another browser (other
 * cookies, other state, not what the agent sees) reaching the sandbox by a
 * URL whose only secret was the sandbox id.
 */
export function CloudBrowserUnavailable({ toolbarAction }: { toolbarAction?: ReactNode }) {
  return (
    <div className="bg-bg-base relative flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center">
      {toolbarAction && <div className="absolute top-1.5 right-2">{toolbarAction}</div>}
      <div className="bg-bg-muted/30 flex h-10 w-10 items-center justify-center rounded-xl">
        <Globe className="text-text-muted/60 h-5 w-5" aria-hidden="true" />
      </div>
      <p className="text-text-secondary text-sm font-medium">
        The browser is on the cloud computer
      </p>
      <p className="text-text-muted max-w-xs text-xs">
        This workspace's agent uses the browser on its own computer in the cloud. Watching that
        browser from here isn't available yet.
      </p>
    </div>
  );
}
