/**
 * A chat's session-level error, inline in the transcript: what went wrong in
 * the person's words, and the one action that can help. A refused AI provider
 * account (`PROVIDER_ACCOUNT_CATEGORY`) opens Settings → AI Providers and
 * offers no retry, since a retry cannot help until the account is fixed.
 */
import { match } from "ts-pattern";
import { MessageSquarePlus, TerminalSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { uiActions } from "@/shared/stores/uiStore";
import { PROVIDER_ACCOUNT_CATEGORY } from "@shared/lib/send-refusal";

/** Settings → AI Providers, where a refused account is connected again. */
function openAIProviders(): void {
  uiActions.setActiveSettingsSection("ai");
  uiActions.openSettings();
}

interface SessionErrorCardProps {
  message: string;
  /** Structured error category (e.g. "auth", "rate_limit", "_provider_account"). */
  category?: string;
  agentHarness?: string | null;
  onOpenLoginTerminal?: () => void;
  onRetryInNewChat?: () => void;
}

export function SessionErrorCard({
  message,
  category,
  agentHarness,
  onOpenLoginTerminal,
  onRetryInNewChat,
}: SessionErrorCardProps) {
  return (
    <>
      {/* The sentence keeps its width: the action wraps under it
        rather than squeezing it into a column (no mid-word breaks). */}
      <div className="border-destructive/20 border-l-destructive bg-destructive/5 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-l-2 px-3 py-2.5">
        <div className="min-w-[min(100%,16rem)] flex-1">
          <p className="text-destructive/80 text-xs font-medium">
            {match(category)
              .with("auth", () => "Authentication Error")
              .with("rate_limit", () => "Rate Limited")
              .with("context_limit", () => "Limit Reached")
              .with("network", () => "Connection Error")
              .with("db_write", () => "Database Error")
              .with("process_exit", () => "Process Crashed")
              .with(PROVIDER_ACCOUNT_CATEGORY, () => "AI account needed")
              .otherwise(() =>
                agentHarness
                  ? `${agentHarness.charAt(0).toUpperCase() + agentHarness.slice(1)} Error`
                  : "Error"
              )}
          </p>
          <p className="text-foreground/80 mt-0.5 text-sm break-words">{message}</p>
          {category === "rate_limit" && (
            <p className="text-muted-foreground mt-1 text-xs">Start a new chat to try again.</p>
          )}
          {category === "process_exit" && (
            <p className="text-muted-foreground mt-1 text-xs">
              The agent process exited unexpectedly. Try sending your message again.
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {match(category)
            .with("auth", () =>
              onOpenLoginTerminal ? (
                <Button variant="outline" size="xs" onClick={onOpenLoginTerminal}>
                  <TerminalSquare className="mr-1.5 h-3.5 w-3.5" />
                  Log in
                </Button>
              ) : null
            )
            // A retry cannot help until the account is fixed.
            .with(PROVIDER_ACCOUNT_CATEGORY, () => (
              <Button variant="outline" size="xs" onClick={openAIProviders}>
                Open AI Providers
              </Button>
            ))
            .with("context_limit", () =>
              onRetryInNewChat ? (
                <Button variant="outline" size="xs" onClick={onRetryInNewChat}>
                  <MessageSquarePlus className="mr-1.5 h-3.5 w-3.5" />
                  New session
                </Button>
              ) : null
            )
            .with("rate_limit", () =>
              onRetryInNewChat ? (
                <Button variant="ghost" size="xs" onClick={onRetryInNewChat}>
                  Retry in new chat
                </Button>
              ) : null
            )
            .with("network", () =>
              onRetryInNewChat ? (
                <Button variant="ghost" size="xs" onClick={onRetryInNewChat}>
                  Retry in new chat
                </Button>
              ) : null
            )
            .with("process_exit", () =>
              onRetryInNewChat ? (
                <Button variant="ghost" size="xs" onClick={onRetryInNewChat}>
                  Retry in new chat
                </Button>
              ) : null
            )
            .otherwise(() =>
              onRetryInNewChat ? (
                <Button variant="ghost" size="xs" onClick={onRetryInNewChat}>
                  Retry in new chat
                </Button>
              ) : null
            )}
        </div>
      </div>
    </>
  );
}
