import { useState, useEffect, useRef } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import type { SettingsSectionProps } from "./types";

export function AISection({ settings, saveSetting }: SettingsSectionProps) {
  // Controlled state for custom endpoint with debounced save
  const [customEndpoint, setCustomEndpoint] = useState(settings.custom_endpoint ?? "");

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track latest typed value and last successfully saved value for safe unmount flush
  const latestValueRef = useRef(customEndpoint);
  const lastSavedRef = useRef(settings.custom_endpoint ?? "");

  // Sync with external changes (e.g., from refetch)
  useEffect(() => {
    setCustomEndpoint(settings.custom_endpoint ?? "");
    lastSavedRef.current = settings.custom_endpoint ?? "";
  }, [settings.custom_endpoint]);

  // Debounced save handler
  const handleEndpointChange = (value: string) => {
    setCustomEndpoint(value);
    latestValueRef.current = value;

    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      saveSetting("custom_endpoint", value);
      lastSavedRef.current = value;
    }, 500);
  };

  // Cleanup timeout on unmount and flush pending changes to prevent data loss
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      if (latestValueRef.current !== lastSavedRef.current) {
        saveSetting("custom_endpoint", latestValueRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold">AI</h3>
        <p className="text-muted-foreground mt-1 text-base">
          Configure your Claude API provider, model, and credentials.
        </p>
      </div>

      {/* API Key */}
      <div className="space-y-2">
        <Label htmlFor="api-key" className="text-sm">
          Anthropic API key
        </Label>
        <p className="text-muted-foreground text-base">
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

      <Separator />

      {/* Provider */}
      <div className="space-y-2">
        <Label htmlFor="provider" className="text-sm">
          Provider
        </Label>
        <p className="text-muted-foreground text-base">Where API requests are routed.</p>
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

      <Separator />

      {/* Model */}
      <div className="space-y-2">
        <Label htmlFor="model" className="text-sm">
          Default model
        </Label>
        <p className="text-muted-foreground text-base">The model used for new conversations.</p>
        <Select
          value={settings.claude_model ?? "sonnet"}
          onValueChange={(value) => saveSetting("claude_model", value)}
        >
          <SelectTrigger id="model" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="sonnet">Claude Sonnet 4.5</SelectItem>
            <SelectItem value="opus">Claude Opus 4.6</SelectItem>
            <SelectItem value="haiku">Claude Haiku 4.5</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Custom endpoint (conditional) */}
      {settings.claude_provider === "custom" && (
        <>
          <Separator />
          <div className="space-y-2">
            <Label htmlFor="custom-endpoint" className="text-sm">
              Custom endpoint URL
            </Label>
            <p className="text-muted-foreground text-base">
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
        </>
      )}
    </div>
  );
}
