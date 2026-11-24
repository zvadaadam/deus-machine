/**
 * A chat's session-level error, inline in the transcript: what went wrong in
 * the person's words, and the one action that can help. A refused AI provider
 * account (`PROVIDER_ACCOUNT_CATEGORY`) opens Settings → AI Providers and
 * offers no retry, since a retry cannot help until the account is fixed.
 */
import { useState, type ReactNode } from "react";
import { match } from "ts-pattern";
import { LogIn, MessageSquarePlus } from "lucide-react";
import { toast } from "sonner";
import { api } from "@shared/api";
import { getErrorMessage } from "@shared/lib/errors";
import { Button } from "@/components/ui/button";
import { call } from "@/platform/ws";
import { uiActions } from "@/shared/stores/uiStore";
import { PROVIDER_ACCOUNT_CATEGORY } from "@shared/lib/send-refusal";

import type { AgentHarness } from "@shared/enums";
import { knownHarness } from "@shared/harnesses";
import { getAgentLabel } from "@/shared/agents";
import { useAgentAuth } from "@/features/settings/api/settings.queries";
import {
  localSignIn,
  readLocalAgent,
  signInLocalAgent,
} from "@/features/settings/lib/local-agent-login";
import { LoginCodeForm } from "@/features/settings/ui/sections/LoginCodeForm";
import { useQueuedMessages } from "../api/session.queries";
import { hasLimitReset, limitTime } from "../lib/queuedMessages";

function UsageLimit({ sessionId, message }: Pick<SessionErrorCardProps, "sessionId" | "message">) {
  const limit = useQueuedMessages(sessionId).data?.limit;
  if (limit?.resetsAt === undefined) return message;
  const hasReset = hasLimitReset(limit.resetsAt);
  const at = limitTime(limit.resetsAt + 60_000);
  const scheduled = limit.continues;
  const continueLabel = hasReset ? "Continue" : `Continue at ${at}`;
  const toggle = () =>
    call(api.continueAfterLimit, { sessionId, on: !scheduled }).catch((error) =>
      toast.error(getErrorMessage(error))
    );
  return (
    <>
      {hasReset ? "Reset" : "Resets"} at {limitTime(limit.resetsAt)}.
      <span className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-2 text-xs">
        {scheduled && `Continues at ${at} while Deus stays open.`}
        <Button variant="outline" size="xs" className="pointer-coarse:min-h-11" onClick={toggle}>
          {scheduled ? "Cancel" : continueLabel}
        </Button>
      </span>
    </>
  );
}

function AIProvidersButton() {
  return (
    <Button variant="outline" size="xs" onClick={uiActions.openAISettings}>
      Open AI Providers
    </Button>
  );
}

interface SessionErrorCardProps {
  sessionId: string;
  message: string;
  /** Structured error category (e.g. "auth", "rate_limit", "_provider_account"). */
  category?: string;
  agentHarness?: string | null;
  cloud?: boolean;
  onRetryInNewChat?: () => void;
}

export function SessionErrorCard({
  sessionId,
  message,
  category,
  agentHarness,
  cloud,
  onRetryInNewChat,
}: SessionErrorCardProps) {
  const title = match(category)
    .with("auth", () => "Authentication Error")
    .with("usage_limit", () => "Usage limit reached")
    .with("rate_limit", () => "Rate Limited")
    .with("context_limit", () => "Limit Reached")
    .with("network", () => "Connection Error")
    .with("db_write", () => "Database Error")
    .with("process_exit", () => "Process Crashed")
    .with(PROVIDER_ACCOUNT_CATEGORY, () => "AI account needed")
    .otherwise(() => (agentHarness ? `${getAgentLabel(agentHarness)} Error` : "Error"));

  let action;
  let description: ReactNode = message;
  if (category === "usage_limit") {
    if (!cloud) description = <UsageLimit sessionId={sessionId} message={message} />;
  } else if (category === "auth" && !cloud) {
    const harness = knownHarness(agentHarness);
    action = harness ? <LoginAction harness={harness} /> : <AIProvidersButton />;
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
        <p className="text-foreground/80 mt-0.5 text-sm break-words">{description}</p>
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
function LoginAction({ harness }: { harness: AgentHarness }) {
  const auth = useAgentAuth();
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
