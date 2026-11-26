import type { GatewayStatus } from "@shared/gateways";
import { needsRemoteAuth } from "@/platform/ws/device-auth";
import { api } from "@shared/api";
import { call } from "@/platform/ws";
import { useGateways } from "@/shared/hooks/useGateways";
import { GatewaysSection } from "./GatewaysSection";
import { useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
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
import { Field, FieldContent, FieldDescription } from "@/components/ui/field";
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
  loadingDefaults = false,
}: SettingsSectionProps & { cloudOnly?: boolean; loadingDefaults?: boolean }) {
  const gateways = useGateways(!cloudOnly);
  const local = !cloudOnly && !needsRemoteAuth();
  const [checking, setChecking] = useState(0);
  const recheck = async (connection: GatewayStatus) => {
    setChecking((n) => n + 1);
    try {
      await call(api.refreshGateway, { generation: connection.generation });
    } finally {
      setChecking((n) => n - 1);
    }
  };
  const agentAuthQuery = useAgentAuth(!cloudOnly);

  const refreshing = agentAuthQuery.isFetching || checking > 0;

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
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">AI Providers</h3>
          <p className="text-muted-foreground mt-1 text-sm">
            Accounts your agents use, on this computer and through gateways.
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Refresh local provider status"
          className="size-8 pointer-coarse:size-11"
          disabled={refreshing}
          onClick={() => {
            void agentAuthQuery.refetch();
            if (local) void Promise.allSettled((gateways.data ?? []).map(recheck));
          }}
        >
          {refreshing ? (
            <Loader2 aria-hidden className="size-4 animate-spin" />
          ) : (
            <RefreshCw aria-hidden className="size-4" />
          )}
        </Button>
      </header>
      <section aria-label="Agents">
        <h4 className="text-muted-foreground text-xs font-medium">Agents</h4>
        <div className="divide-border-subtle divide-y">
          {LOCAL_HARNESSES.map((harness) => (
            <LocalAgentRow
              key={harness}
              harness={harness}
              state={readLocalAgent(agentAuthQuery, harness)}
            />
          ))}
        </div>
      </section>
      <GatewaysSection
        gateways={gateways.data}
        error={gateways.error?.message}
        local={local}
        recheck={recheck}
        checking={checking > 0}
      />
      <section aria-label="Defaults">
        <h4 className="text-muted-foreground mb-1 text-xs font-medium">Defaults</h4>
        <div className="divide-border-subtle divide-y">
          <Field orientation="horizontal" className="items-center justify-between py-2.5">
            <Label htmlFor="thinking-level">Default thinking</Label>
            <Select
              disabled={loadingDefaults}
              value={readThinkingLevel(settings.default_thinking_level) ?? DEFAULT_THINKING_LEVEL}
              onValueChange={(v) => saveSetting("default_thinking_level", v)}
            >
              <SelectTrigger id="thinking-level" className="w-24">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {["low", "medium", "high"].map((v) => (
                  <SelectItem key={v} value={v}>
                    {v[0]?.toUpperCase() + v.slice(1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field orientation="horizontal" className="items-center justify-between py-2.5">
            <Label htmlFor="continue-after-limit">Continue after a usage limit</Label>
            <Switch
              disabled={loadingDefaults}
              id="continue-after-limit"
              checked={settings.continue_after_usage_limit === true}
              onCheckedChange={(on) => saveSetting("continue_after_usage_limit", on)}
            />
          </Field>
          <Field orientation="horizontal" className="items-center justify-between py-2.5">
            <FieldContent>
              <Label htmlFor="agent-messages">Agent messages</Label>
              <FieldDescription id="agent-messages-description">
                Agents send you updates while they work.
              </FieldDescription>
            </FieldContent>
            <Switch
              disabled={loadingDefaults}
              id="agent-messages"
              aria-describedby="agent-messages-description"
              checked={settings.agent_messages !== false}
              onCheckedChange={(on) => saveSetting("agent_messages", on)}
            />
          </Field>
        </div>
      </section>
      <ProviderAccounts />
    </div>
  );
}
