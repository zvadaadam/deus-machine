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

import { m, useReducedMotion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { EASE_OUT_QUART } from "@/shared/lib/animation";
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

// Staggered fade-in variants
const containerVariants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.08 },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 12 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.35, ease: EASE_OUT_QUART },
  },
};

export function ServerOfflinePage({ onRetry, variant }: ServerOfflinePageProps) {
  const copy = COPY[variant];
  const reduceMotion = useReducedMotion();
  const variants = reduceMotion ? undefined : itemVariants;

  return (
    <div className="bg-background flex h-screen w-full items-center justify-center p-6">
      <m.div
        className="flex max-w-[380px] flex-col items-center gap-6 text-center"
        {...(!reduceMotion && {
          variants: containerVariants,
          initial: "hidden",
          animate: "visible",
        })}
      >
        <m.div variants={variants}>
          <ConnectionIllustration className="w-[260px] opacity-80" />
        </m.div>

        <m.h1 variants={variants} className="text-foreground text-xl font-semibold tracking-tight">
          {copy.heading}
        </m.h1>

        <m.p
          variants={variants}
          className="text-muted-foreground max-w-[340px] text-sm leading-relaxed"
        >
          {copy.body}
        </m.p>

        {variant === "desktop" && (
          <m.div variants={variants}>
            <Button variant="outline" size="sm" onClick={onRetry}>
              Try again
            </Button>
          </m.div>
        )}

        <m.div variants={variants} className="flex items-center gap-2">
          <WaitingDots reduced={reduceMotion} />
          <span className="text-text-muted text-xs">Waiting for connection</span>
        </m.div>
      </m.div>
    </div>
  );
}

/** Three pulsing dots — communicates "I'm alive and checking" */
function WaitingDots({ reduced }: { reduced: boolean | null }) {
  return (
    <div className="flex items-center gap-1">
      {[0, 1, 2].map((i) =>
        reduced ? (
          <span key={i} className="bg-text-muted size-1 rounded-full opacity-40" />
        ) : (
          <m.span
            key={i}
            className="bg-text-muted size-1 rounded-full"
            animate={{ opacity: [0.2, 0.8, 0.2] }}
            transition={{
              duration: 1.5,
              repeat: Infinity,
              delay: i * 0.2,
              ease: "linear",
            }}
          />
        )
      )}
    </div>
  );
}
