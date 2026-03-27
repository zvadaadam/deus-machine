import { useState, useEffect, useRef } from "react";
import { CheckCircle2, XCircle, Loader2, RefreshCw, ExternalLink, Terminal } from "lucide-react";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { isElectronEnv } from "@/platform/electron/invoke";
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
import type { AgentProviderAuth } from "../../types";

function AuthBadge({
  auth,
  installed,
  isLoading,
}: {
  auth: AgentProviderAuth | null | undefined;
  installed: boolean | undefined;
  isLoading: boolean;
}) {
  const isAuthenticated = auth && !auth.error && auth.accountInfo;

  if (isLoading) {
    return <Loader2 className="text-muted-foreground size-4 animate-spin" />;
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

  if (isAuthenticated) {
    return (
      <div className="flex items-center gap-1.5 text-emerald-500">
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

function openInTerminal(command: string) {
  if (isElectronEnv && window.electronAPI?.openTerminal) {
    window.electronAPI.openTerminal(command);
  } else {
    navigator.clipboard.writeText(command);
    toast.success("Copied to clipboard", {
      description: `Run ${command} in your terminal`,
    });
  }
}

export function AISection({ settings, saveSetting }: SettingsSectionProps) {
  const agentAuthQuery = useAgentAuth();
  const claudeAuth = agentAuthQuery.data?.claude;
  const codexAuth = agentAuthQuery.data?.codex;
  const agents = agentAuthQuery.data?.agents ?? [];
  const claudeInstalled = agents.find((a) => a.type === "claude")?.installed;
  const codexInstalled = agents.find((a) => a.type === "codex")?.installed;
  const claudeConnected = claudeAuth && !claudeAuth.error && claudeAuth.accountInfo;
  const codexConnected = codexAuth && !codexAuth.error && codexAuth.accountInfo;

  // Controlled state for custom endpoint with debounced save
  const [customEndpoint, setCustomEndpoint] = useState(settings.custom_endpoint ?? "");

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestValueRef = useRef(customEndpoint);
  const lastSavedRef = useRef(settings.custom_endpoint ?? "");

  useEffect(() => {
    setCustomEndpoint(settings.custom_endpoint ?? "");
    lastSavedRef.current = settings.custom_endpoint ?? "";
  }, [settings.custom_endpoint]);

  const handleEndpointChange = (value: string) => {
    setCustomEndpoint(value);
    latestValueRef.current = value;
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      saveSetting("custom_endpoint", value);
      lastSavedRef.current = value;
    }, 500);
  };

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (latestValueRef.current !== lastSavedRef.current) {
        saveSetting("custom_endpoint", latestValueRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-base font-semibold">AI Providers</h3>
          <p className="text-muted-foreground mt-1 text-base">
            Manage AI provider connections, credentials, and model preferences.
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0"
          onClick={() => agentAuthQuery.refetch()}
          disabled={agentAuthQuery.isFetching}
        >
          <RefreshCw className={`size-3.5 ${agentAuthQuery.isFetching ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* ================================================================
          Claude Code
          ================================================================ */}
      <div className="border-border-subtle space-y-4 rounded-lg border p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Claude Code</p>
            <p className="text-muted-foreground text-sm">Anthropic</p>
            {claudeConnected && claudeAuth?.accountInfo?.email && (
              <p className="text-muted-foreground mt-0.5 text-xs">
                {claudeAuth.accountInfo.email}
                {claudeAuth.accountInfo.orgName ? ` · ${claudeAuth.accountInfo.orgName}` : ""}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <AuthBadge
              auth={claudeAuth}
              installed={claudeInstalled}
              isLoading={agentAuthQuery.isLoading}
            />
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
            {!agentAuthQuery.isLoading && claudeInstalled && !claudeConnected && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={() => openInTerminal("claude login")}
              >
                <Terminal className="size-3" />
                claude login
              </Button>
            )}
          </div>
        </div>

        <Separator />

        {/* API Key */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="api-key" className="text-sm">
              API key
            </Label>
            <a
              href="https://console.anthropic.com/settings/keys"
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors"
            >
              Get key
              <ExternalLink className="size-3" />
            </a>
          </div>
          <p className="text-muted-foreground text-sm">
            Used for direct API access. Stored locally on your machine.
          </p>
          <Input
            id="api-key"
            type="password"
            defaultValue={settings.anthropic_api_key ?? ""}
            onBlur={(e) => saveSetting("anthropic_api_key", e.currentTarget.value)}
            placeholder="sk-ant-api03-..."
          />
        </div>

        {/* Provider */}
        <div className="space-y-2">
          <Label htmlFor="provider" className="text-sm">
            Provider
          </Label>
          <p className="text-muted-foreground text-sm">Where API requests are routed.</p>
          <Select
            value={settings.claude_provider ?? "anthropic"}
            onValueChange={(value) => saveSetting("claude_provider", value)}
          >
            <SelectTrigger id="provider" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="anthropic">Anthropic (Official)</SelectItem>
              <SelectItem value="custom">Custom Endpoint</SelectItem>
              <SelectItem value="bedrock">AWS Bedrock</SelectItem>
              <SelectItem value="vertex">Google Vertex AI</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Model */}
        <div className="space-y-2">
          <Label htmlFor="model" className="text-sm">
            Default model
          </Label>
          <p className="text-muted-foreground text-sm">The model used for new conversations.</p>
          <Select
            value={settings.claude_model ?? "opus"}
            onValueChange={(value) => saveSetting("claude_model", value)}
          >
            <SelectTrigger id="model" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="sonnet">Claude Sonnet 4.6</SelectItem>
              <SelectItem value="opus">Claude Opus 4.6</SelectItem>
              <SelectItem value="haiku">Claude Haiku 4.5</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Custom endpoint (conditional) */}
        {settings.claude_provider === "custom" && (
          <div className="space-y-2">
            <Label htmlFor="custom-endpoint" className="text-sm">
              Custom endpoint URL
            </Label>
            <p className="text-muted-foreground text-sm">
              The base URL for your custom Claude-compatible API.
            </p>
            <Input
              id="custom-endpoint"
              type="url"
              placeholder="https://api.example.com/v1"
              value={customEndpoint}
              onChange={(e) => handleEndpointChange(e.target.value)}
            />
          </div>
        )}
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
          <div className="flex items-center gap-2">
            <AuthBadge
              auth={codexAuth}
              installed={codexInstalled}
              isLoading={agentAuthQuery.isLoading}
            />
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
            {!agentAuthQuery.isLoading && codexInstalled && !codexConnected && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 text-xs"
                onClick={() => openInTerminal("codex login")}
              >
                <Terminal className="size-3" />
                codex login
              </Button>
            )}
          </div>
        </div>

        <Separator />

        {/* OpenAI API Key */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="openai-api-key" className="text-sm">
              API key
            </Label>
            <a
              href="https://platform.openai.com/api-keys"
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors"
            >
              Get key
              <ExternalLink className="size-3" />
            </a>
          </div>
          <p className="text-muted-foreground text-sm">
            Required for Codex. Stored locally on your machine.
          </p>
          <Input
            id="openai-api-key"
            type="password"
            defaultValue={settings.openai_api_key ?? ""}
            onBlur={(e) => saveSetting("openai_api_key", e.currentTarget.value)}
            placeholder="sk-..."
          />
        </div>
      </div>
    </div>
  );
}
