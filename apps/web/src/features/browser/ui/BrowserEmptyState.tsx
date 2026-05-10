/**
 * BrowserEmptyState — shown in the Browser tab when no page is loaded.
 *
 * If the backend has discovered local dev servers, we show the list and
 * nothing else — the URL bar at the top is enough of a hint. If no servers
 * were detected, fall back to the original "Paste a URL" placeholder so
 * the tab still has a clear empty state.
 */

import { Globe } from "lucide-react";
import { useLocalServers } from "../api/browser.queries";
import { LocalServerCard } from "./LocalServerCard";

interface BrowserEmptyStateProps {
  /** Called when the user clicks a local server card. */
  onOpen: (url: string) => void;
}

export function BrowserEmptyState({ onOpen }: BrowserEmptyStateProps) {
  const { data, isLoading } = useLocalServers();
  const servers = data.servers;

  if (isLoading || data.isLoading) {
    return (
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <p className="text-muted-foreground/60 text-sm">Looking for local servers...</p>
      </div>
    );
  }

  if (servers.length > 0) {
    // Outer scrolls; inner uses min-h-full + flex centering so the list is
    // vertically centered when it fits and scrolls naturally when it doesn't.
    return (
      <div className="absolute inset-0 overflow-y-auto">
        <div className="flex min-h-full items-center justify-center px-6 py-10">
          <div className="w-full max-w-md">
            <h2 className="text-muted-foreground/60 mb-2 px-1 text-xs font-semibold tracking-wide uppercase">
              Running locally
            </h2>
            <ul className="flex flex-col gap-1.5">
              {servers.map((server) => (
                <li key={server.url}>
                  <LocalServerCard server={server} onOpen={onOpen} />
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3">
      <div className="bg-muted/50 flex h-10 w-10 items-center justify-center rounded-xl">
        <Globe className="text-muted-foreground/60 h-5 w-5" strokeWidth={1.5} aria-hidden="true" />
      </div>
      <div className="text-center">
        <p className="text-muted-foreground text-sm">
          Paste a URL above or ask the Agent to browse
        </p>
        <p className="text-muted-foreground/40 mt-1 text-xs">
          Supports any website — cookies, auth, and devtools included
        </p>
      </div>
    </div>
  );
}
