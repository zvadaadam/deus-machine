/**
 * Relay gates that come before pairing: the browser must be signed in to the
 * Deus account the computer belongs to, and that account must still have it.
 */
import { useEffect } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { ConnectionIllustration } from "@/features/connection/ui/ConnectionIllustration";
import {
  beginWebCloudLogin,
  redirectToWebCloudLogin,
  wasSignedOutDeliberately,
} from "@/features/session/cloud/webCloudDirectConfig";
import { stashPairCode } from "../lib/pairing-link";

function GateLayout({
  heading,
  body,
  children,
}: {
  heading: string;
  body: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-background flex h-screen w-full items-center justify-center p-6">
      <div className="flex max-w-[380px] flex-col items-center gap-6 text-center [--enter-y:12px]">
        <div className="enter-step">
          <ConnectionIllustration className="w-[260px] opacity-80" />
        </div>
        <h1 className="enter-step text-foreground text-xl font-semibold tracking-tight [--step:1]">
          {heading}
        </h1>
        <p className="enter-step text-muted-foreground max-w-[340px] text-sm leading-relaxed [--step:2]">
          {body}
        </p>
        <div className="enter-step flex items-center gap-2 [--step:3]">{children}</div>
      </div>
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
