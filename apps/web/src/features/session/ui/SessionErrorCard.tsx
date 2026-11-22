/**
 * A chat's session-level error, inline in the transcript: what went wrong in
 * the person's words, and the one action that can help. A refused AI provider
 * account (`PROVIDER_ACCOUNT_CATEGORY`) opens Settings → AI Providers and
 * offers no retry, since a retry cannot help until the account is fixed.
 */
import { useState } from "react";
import { match } from "ts-pattern";
import { LogIn, MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { uiActions } from "@/shared/stores/uiStore";
import { PROVIDER_ACCOUNT_CATEGORY } from "@shared/lib/send-refusal";

import { getAgentLabel } from "@/shared/agents";
import type { LocalHarness } from "@shared/agent-auth";
import { useAgentAuth, useAgentAuthEvents } from "@/features/settings/api/settings.queries";
import {
  localSignIn,
  readLocalAgent,
  signInLocalAgent,
} from "@/features/settings/lib/local-agent-login";
import { LoginCodeForm } from "@/features/settings/ui/sections/LoginCodeForm";

function AIProvidersButton() {
  return (
    <Button
      variant="outline"
      size="xs"
      onClick={() => {
        uiActions.setActiveSettingsSection("ai");
        uiActions.openSettings();
      }}
    >
      Open AI Providers
    </Button>
  );
}

interface SessionErrorCardProps {
  message: string;
  /** Structured error category (e.g. "auth", "rate_limit", "_provider_account"). */
  category?: string;
  agentHarness?: LocalHarness | null;
  cloud?: boolean;
  onRetryInNewChat?: () => void;
}

export function SessionErrorCard({
  message,
  category,
  agentHarness,
  cloud,
  onRetryInNewChat,
}: SessionErrorCardProps) {
  const title = match(category)
    .with("auth", () => "Authentication Error")
    .with("rate_limit", () => "Rate Limited")
    .with("context_limit", () => "Limit Reached")
    .with("network", () => "Connection Error")
    .with("db_write", () => "Database Error")
    .with("process_exit", () => "Process Crashed")
    .with(PROVIDER_ACCOUNT_CATEGORY, () => "AI account needed")
    .otherwise(() => (agentHarness ? `${getAgentLabel(agentHarness)} Error` : "Error"));

  let action;
  if (category === "auth" && !cloud && agentHarness) {
    action = <LoginAction harness={agentHarness} />;
  } else if (category === "auth" || category === PROVIDER_ACCOUNT_CATEGORY) {
    action = <AIProvidersButton />;
  } else if (onRetryInNewChat) {
    action = (
      <Button
        variant={category === "context_limit" ? "outline" : "ghost"}
        size="xs"
        onClick={() => onRetryInNewChat()}
      >
        <MessageSquarePlus className="mr-1.5 size-3.5" />
        {category === "context_limit" ? "New session" : "New chat"}
      </Button>
    );
  }

  return (
    <div className="border-destructive/20 border-l-destructive bg-destructive/5 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-l-2 px-3 py-2.5">
      <div className="min-w-[min(100%,16rem)] flex-1">
        <p className="text-destructive/80 text-xs font-medium">{title}</p>
        <p className="text-foreground/80 mt-0.5 text-sm break-words">{message}</p>
        {category === "rate_limit" && onRetryInNewChat && (
          <p className="text-muted-foreground mt-1 text-xs">Start a new chat to try again.</p>
        )}
        {category === "process_exit" && (
          <p className="text-muted-foreground mt-1 text-xs">
            The agent process exited unexpectedly. Try sending your message again.
          </p>
        )}
      </div>
      {action}
    </div>
  );
}

/** Only a local authentication error needs the local CLI's sign-in methods. */
function LoginAction({ harness }: { harness: LocalHarness }) {
  const auth = useAgentAuth();
  useAgentAuthEvents();
  const [busy, setBusy] = useState(false);
  const signIn = localSignIn(readLocalAgent(auth, harness));
  if (!signIn) return <AIProvidersButton />;
  if (signIn.kind === "code") return <LoginCodeForm loginId={signIn.loginId} />;
  return (
    <Button
      variant="outline"
      size="xs"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void signInLocalAgent(harness, signIn.auth).finally(() => setBusy(false));
      }}
    >
      <LogIn className="mr-1.5 size-3.5" />
      Sign in
    </Button>
  );
}
