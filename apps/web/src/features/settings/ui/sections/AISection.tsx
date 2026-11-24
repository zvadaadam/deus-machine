import { RefreshCw } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";
import { useAgentAuth } from "../../api/settings.queries";
import type { SettingsSectionProps } from "./types";
import { readThinkingLevel } from "@shared/protocol";
import { LOCAL_HARNESSES } from "@shared/harnesses";
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
      {LOCAL_HARNESSES.map((harness) => (
        <LocalAgentRow
          key={harness}
          harness={harness}
          state={readLocalAgent(agentAuthQuery, harness)}
        />
      ))}
      <div className="space-y-4">
        <Separator />

        <Field orientation="horizontal">
          <FieldContent>
            <FieldLabel htmlFor="agent-messages">Agent messages</FieldLabel>
            <FieldDescription>
              In new local chats, agents send you updates while they work. In Chat bubbles, their
              other text waits inside the work line.
            </FieldDescription>
          </FieldContent>
          <Switch
            id="agent-messages"
            checked={settings.agent_messages !== false}
            onCheckedChange={(checked) => saveSetting("agent_messages", checked)}
          />
        </Field>
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
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="continue-after-limit">
            When a usage limit resets, continue the chats it stopped.
          </Label>
          <Switch
            id="continue-after-limit"
            checked={settings.continue_after_usage_limit === true}
            onCheckedChange={(on) => saveSetting("continue_after_usage_limit", on)}
          />
        </div>
      </div>
    </div>
  );
}
