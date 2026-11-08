/**
 * Relay gates that come before pairing: the browser must be signed in to the
 * Deus account the computer belongs to, and that account must still have it.
 */
import { useEffect } from "react";
import { m, useReducedMotion } from "framer-motion";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { ConnectionIllustration } from "@/features/connection/ui/ConnectionIllustration";
import {
  beginWebCloudLogin,
  redirectToWebCloudLogin,
  wasSignedOutDeliberately,
} from "@/features/session/cloud/webCloudDirectConfig";
import { EASE_OUT_QUART } from "@/shared/lib/animation";
import { stashPairCode } from "../lib/pairing-link";

const containerVariants = { hidden: {}, visible: { transition: { staggerChildren: 0.08 } } };
const itemVariants = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.35, ease: EASE_OUT_QUART } },
};

function GateLayout({
  heading,
  body,
  children,
}: {
  heading: string;
  body: string;
  children: React.ReactNode;
}) {
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
          {heading}
        </m.h1>
        <m.p
          variants={variants}
          className="text-muted-foreground max-w-[340px] text-sm leading-relaxed"
        >
          {body}
        </m.p>
        <m.div variants={variants} className="flex items-center gap-2">
          {children}
        </m.div>
      </m.div>
    </div>
  );
}

const returnPath = () => `${window.location.pathname}${window.location.search}`;

/** The relay serves a computer only to its own account: sign in first. */
export function RelaySignInPage({ serverId }: { serverId: string }) {
  useEffect(() => {
    // A pairing link's code must survive the sign-in round trip.
    stashPairCode(serverId);
    // Signing in again is one redirect while the identity provider remembers the user.
    if (!wasSignedOutDeliberately()) redirectToWebCloudLogin(returnPath());
  }, [serverId]);

  return (
    <GateLayout
      heading="Sign in to reach your computer"
      body="Use the Deus account your computer is signed in to. Devices you approved before connect again without a new code."
    >
      <Button size="sm" onClick={() => beginWebCloudLogin(returnPath())}>
        Sign in
      </Button>
    </GateLayout>
  );
}

/** Deus Cloud has no such computer for this account (removed, or another account's). */
export function MachineUnavailablePage({ onRetry }: { onRetry: () => void }) {
  return (
    <GateLayout
      heading="This computer isn't on your account"
      body="It may have been removed, or it is signed in to a different Deus account. Turn on Remote access in Deus on that computer, signed in to this account."
    >
      <Button size="sm" asChild>
        <Link to="/connect">Your computers</Link>
      </Button>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </GateLayout>
  );
}
