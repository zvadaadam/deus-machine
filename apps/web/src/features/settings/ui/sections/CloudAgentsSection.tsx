import { CheckCircle2, CircleAlert, Cloud, ExternalLink, Server } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import type { SettingsSectionProps } from "./types";

function SetupState({ configured }: { configured: boolean }) {
  if (configured) {
    return (
      <span className="text-success flex items-center gap-1.5 text-xs font-medium">
        <CheckCircle2 className="size-3.5" />
        Saved
      </span>
    );
  }

  return (
    <span className="text-warning flex items-center gap-1.5 text-xs font-medium">
      <CircleAlert className="size-3.5" />
      Required
    </span>
  );
}

export function CloudAgentsSection({ settings, saveSetting }: SettingsSectionProps) {
  const deusKeyConfigured = Boolean(settings.deus_api_key?.trim());
  const anthropicKeyConfigured = Boolean(settings.anthropic_api_key?.trim());
  const ready = deusKeyConfigured && anthropicKeyConfigured;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold">Cloud Agents</h3>
          <p className="text-muted-foreground mt-1 text-base">
            Setup for Deus Cloud workspaces and cloud Claude sessions.
          </p>
        </div>
        <div
          className={`mt-0.5 flex shrink-0 items-center gap-1.5 text-xs font-medium ${
            ready ? "text-success" : "text-warning"
          }`}
        >
          {ready ? <CheckCircle2 className="size-3.5" /> : <CircleAlert className="size-3.5" />}
          {ready ? "Ready" : "Setup needed"}
        </div>
      </div>

      <div className="border-border-subtle space-y-4 rounded-lg border p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-lg">
              <Cloud className="text-muted-foreground size-4" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium">Deus Cloud</p>
              <p className="text-muted-foreground text-sm">Workspace runtime</p>
            </div>
          </div>
          <SetupState configured={deusKeyConfigured} />
        </div>

        <Separator />

        <div className="space-y-2">
          <Label htmlFor="cloud-deus-api-key" className="text-sm">
            Deus API key
          </Label>
          <p className="text-muted-foreground text-sm">
            Required for creating, streaming, and stopping cloud workspaces.
          </p>
          <Input
            id="cloud-deus-api-key"
            type="password"
            defaultValue={settings.deus_api_key ?? ""}
            onBlur={(e) => saveSetting("deus_api_key", e.currentTarget.value.trim())}
            placeholder="deus_sk_..."
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="cloud-deus-base-url" className="text-sm">
            API endpoint
          </Label>
          <p className="text-muted-foreground text-sm">
            Optional. Blank uses the production Deus Cloud API.
          </p>
          <Input
            id="cloud-deus-base-url"
            type="url"
            defaultValue={settings.deus_base_url ?? ""}
            onBlur={(e) => saveSetting("deus_base_url", e.currentTarget.value.trim())}
            placeholder="https://api.deusmachine.ai"
          />
        </div>
      </div>

      <div className="border-border-subtle space-y-4 rounded-lg border p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-lg">
              <Server className="text-muted-foreground size-4" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium">Anthropic</p>
              <p className="text-muted-foreground text-sm">Claude runtime</p>
            </div>
          </div>
          <SetupState configured={anthropicKeyConfigured} />
        </div>

        <Separator />

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="cloud-anthropic-api-key" className="text-sm">
              Anthropic API key
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
            Shared with AI Providers and passed to cloud Claude sessions.
          </p>
          <Input
            id="cloud-anthropic-api-key"
            type="password"
            defaultValue={settings.anthropic_api_key ?? ""}
            onBlur={(e) => saveSetting("anthropic_api_key", e.currentTarget.value.trim())}
            placeholder="sk-ant-api03-..."
          />
        </div>
      </div>
    </div>
  );
}
