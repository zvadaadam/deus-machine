/**
 * ServerOfflinePage — full-page state when the backend is unreachable.
 *
 * Replaces the plain "Cannot connect to server" error pages in both
 * DesktopShell and ServerLayout. Features the warm illustration,
 * clear copy, and a "Waiting for connection" indicator.
 *
 * Two variants:
 *   "desktop" — "Desktop app not detected", shows retry button
 *   "relay"   — "Your computer isn't connected", no retry (relay handles it)
 */

import { Button } from "@/components/ui/button";
import { ConnectionIllustration } from "./ConnectionIllustration";

interface ServerOfflinePageProps {
  onRetry: () => void;
  variant: "desktop" | "relay";
}

const COPY = {
  desktop: {
    heading: "Desktop app not detected",
    body: "Open the Deus desktop app to connect this browser session to your agents and workspaces.",
  },
  relay: {
    heading: "Your computer isn't connected",
    body: "Make sure the Deus desktop app is running on your computer. This page will connect automatically.",
  },
} as const;

export function ServerOfflinePage({ onRetry, variant }: ServerOfflinePageProps) {
  const copy = COPY[variant];

  return (
    <div className="bg-background flex h-screen w-full items-center justify-center p-6">
      <div className="flex max-w-[380px] flex-col items-center gap-6 text-center [--enter-y:12px]">
        <div className="enter-step">
          <ConnectionIllustration className="w-[260px] opacity-80" />
        </div>

        <h1 className="enter-step text-foreground text-xl font-semibold tracking-tight [--step:1]">
          {copy.heading}
        </h1>

        <p className="enter-step text-muted-foreground max-w-[340px] text-sm leading-relaxed [--step:2]">
          {copy.body}
        </p>

        {variant === "desktop" && (
          <div className="enter-step [--step:3]">
            <Button variant="outline" size="sm" onClick={onRetry}>
              Try again
            </Button>
          </div>
        )}

        <div
          className={`enter-step flex items-center gap-2 ${variant === "desktop" ? "[--step:4]" : "[--step:3]"}`}
        >
          <WaitingDots />
          <span className="text-text-muted text-xs">Waiting for connection</span>
        </div>
      </div>
    </div>
  );
}

/** Three pulsing dots — communicates "I'm alive and checking" */
function WaitingDots() {
  return (
    <div className="flex items-center gap-1">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="bg-text-muted size-1 rounded-full opacity-40 motion-safe:animate-[waiting-dot_1.5s_linear_infinite]"
          style={{ animationDelay: `${i * 0.2}s` }}
        />
      ))}
    </div>
  );
}
