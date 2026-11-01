import { RefreshCw } from "lucide-react";
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
import { useAgentAuth, useAgentAuthEvents } from "../../api/settings.queries";
import type { SettingsSectionProps } from "./types";
import { readThinkingLevel } from "@shared/protocol";
import { DEFAULT_THINKING_LEVEL } from "@/shared/agents";
import { ProviderAccounts } from "./ProviderAccounts";
import { LocalAgentRow } from "./LocalAgentRow";
import { readLocalAgent } from "../../lib/local-agent-login";

export function AISection({
  settings,
  saveSetting,
  cloudOnly = false,
}: SettingsSectionProps & { cloudOnly?: boolean }) {
  const agentAuthQuery = useAgentAuth(!cloudOnly);
  useAgentAuthEvents();

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
      <LocalAgentRow
        harness="claude-code"
        title="Claude Code"
        vendor="Anthropic"
        state={readLocalAgent(agentAuthQuery, "claude-code")}
      />
      <LocalAgentRow
        harness="codex-app-server"
        title="Codex"
        vendor="OpenAI"
        state={readLocalAgent(agentAuthQuery, "codex-app-server")}
      />
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
            value={readThinkingLevel(settings.default_thinking_level) ?? DEFAULT_THINKING_LEVEL}
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
