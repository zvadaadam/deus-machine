import { CheckCircle2, XCircle, Loader2, RefreshCw, ExternalLink, Terminal } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useAgentAuth } from "../../api/settings.queries";
import type { SettingsSectionProps } from "./types";
import { readThinkingLevel } from "@shared/protocol";
import { ProviderAccounts } from "./ProviderAccounts";
import { readLocalProviderAuth, type LocalProviderAuthState } from "../../lib/local-provider-auth";
import { openProviderLogin } from "../../lib/open-provider-login";

function AuthBadge({
  auth,
  installed,
}: {
  auth: LocalProviderAuthState;
  installed: boolean | undefined;
}) {
  if (auth.status === "checking") {
    return <Loader2 className="text-muted-foreground size-4 animate-spin" />;
  }

  if (installed === undefined || auth.status === "failed") {
    return <span className="text-muted-foreground text-xs font-medium">Status unavailable</span>;
  }

  // Not installed at all
  if (installed === false) {
    return (
      <div className="text-muted-foreground flex items-center gap-1.5">
        <XCircle className="size-4" />
        <span className="text-xs font-medium">Not installed</span>
      </div>
    );
  }

  if (auth.status === "signed-in") {
    return (
      <div className="text-accent-green flex items-center gap-1.5">
        <CheckCircle2 className="size-4" />
        <span className="text-xs font-medium">Connected</span>
      </div>
    );
  }

  return (
    <div className="text-muted-foreground flex items-center gap-1.5">
      <XCircle className="size-4" />
      <span className="text-xs font-medium">Not connected</span>
    </div>
  );
}

export function AISection({
  settings,
  saveSetting,
  cloudOnly = false,
}: SettingsSectionProps & { cloudOnly?: boolean }) {
  const agentAuthQuery = useAgentAuth(!cloudOnly);
  const authStatus =
    agentAuthQuery.isError || agentAuthQuery.data?.error ? undefined : agentAuthQuery.data;
  const claudeAuth = readLocalProviderAuth(agentAuthQuery, "claude");
  const codexAuthState = readLocalProviderAuth(agentAuthQuery, "codex");
  const codexAuth = authStatus?.codex;
  const agents = authStatus?.agents;
  const claudeInstalled = agents?.some((a) => a.type === "claude-code" && a.installed);
  const codexInstalled = agents?.some(
    (a) => (a.type === "codex-app-server" || a.type === "codex-sdk") && a.installed
  );

  if (cloudOnly) {
    return (
      <div className="space-y-5">
        <div>
          <h3 className="text-base font-semibold">AI Providers</h3>
          <p className="text-text-muted mt-1 text-base">
            Connect the accounts you use for cloud agents.
          </p>
        </div>
        <ProviderAccounts />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-base font-semibold">AI Providers</h3>
          <p className="text-muted-foreground mt-1 text-base">
            Manage AI accounts and choose models in each conversation.
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Refresh local provider status"
          className="size-8 shrink-0"
          onClick={() => agentAuthQuery.refetch()}
          disabled={agentAuthQuery.isFetching}
        >
          <RefreshCw className={`size-3.5 ${agentAuthQuery.isFetching ? "animate-spin" : ""}`} />
        </Button>
      </div>

      <ProviderAccounts />

      <div>
        <h4 className="text-text-primary text-sm font-medium">On this computer</h4>
        <p className="text-text-muted mt-1 text-sm">
          Local agents use their own CLI login. Cloud account defaults do not change it.
        </p>
      </div>
      <div className="border-border-subtle space-y-4 rounded-lg border p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Claude Code</p>
            <p className="text-muted-foreground text-sm">Anthropic</p>
            {claudeAuth.status === "signed-in" && claudeAuth.accountInfo.email && (
              <p className="text-muted-foreground mt-0.5 text-xs">
                {claudeAuth.accountInfo.email}
                {claudeAuth.accountInfo.orgName ? ` · ${claudeAuth.accountInfo.orgName}` : ""}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <AuthBadge auth={claudeAuth} installed={claudeInstalled} />
            {!agentAuthQuery.isLoading && claudeInstalled === false && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={() =>
                  window.open("https://docs.anthropic.com/en/docs/claude-code/overview", "_blank")
                }
              >
                Install
                <ExternalLink className="size-3" />
              </Button>
            )}
            {claudeInstalled && claudeAuth.status === "signed-out" && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={() => void openProviderLogin("claude")}
              >
                <Terminal className="size-3" />
                Sign in
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* ================================================================
          Codex
          ================================================================ */}
      <div className="border-border-subtle space-y-4 rounded-lg border p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Codex</p>
            <p className="text-muted-foreground text-sm">OpenAI</p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {!agentAuthQuery.isLoading && codexInstalled && codexAuth == null ? (
              <span className="text-text-muted text-xs">Login managed by Codex</span>
            ) : (
              <AuthBadge auth={codexAuthState} installed={codexInstalled} />
            )}
            {!agentAuthQuery.isLoading && codexInstalled === false && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={() => window.open("https://developers.openai.com/codex/cli", "_blank")}
              >
                Install
                <ExternalLink className="size-3" />
              </Button>
            )}
            {codexInstalled && codexAuthState.status === "signed-out" && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={() => void openProviderLogin("codex")}
              >
                <Terminal className="size-3" />
                Sign in
              </Button>
            )}
          </div>
        </div>
      </div>
      <div className="space-y-4">
        <Separator />

        {/* Default thinking level */}
        <div className="space-y-2">
          <Label htmlFor="thinking-level" className="text-sm">
            Default thinking
          </Label>
          <p className="text-muted-foreground text-sm">
            How hard the model should think by default. Individual turns can still be adjusted via
            the thinking indicator next to the model picker.
          </p>
          <Select
            value={readThinkingLevel(settings.default_thinking_level) ?? "high"}
            onValueChange={(value) => saveSetting("default_thinking_level", value)}
          >
            <SelectTrigger id="thinking-level" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="low">Low</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="high">High</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}
