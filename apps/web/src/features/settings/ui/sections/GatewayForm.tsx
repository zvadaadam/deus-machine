import { useState, type FormEvent } from "react";
import { api } from "@shared/api";
import {
  GATEWAY_PRESETS,
  type GatewayFormat,
  type GatewayPreset,
  type GatewayStatus,
} from "@shared/gateways";
import { getErrorMessage } from "@shared/lib/errors";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { openExternal } from "@/platform/native/window";
import { call } from "@/platform/ws";

export function ProviderRules({
  rules,
}: {
  rules: NonNullable<(typeof GATEWAY_PRESETS)[GatewayPreset]["rules"]>;
}) {
  return (
    <div data-gateway-details="" className="text-text-secondary space-y-1 text-xs">
      <p>{rules.warning}</p>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span>Provider rules</span>
        {rules.links.map(([name, url]) => (
          <a
            key={name}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground underline underline-offset-2"
            onClick={(event) => {
              event.preventDefault();
              void openExternal(url);
            }}
          >
            {name}
          </a>
        ))}
      </div>
    </div>
  );
}

export function GatewayForm({
  preset,
  gateway,
  local,
  returnFocus,
  onClose,
}: {
  preset: GatewayPreset;
  gateway?: GatewayStatus;
  local: boolean;
  returnFocus(): void;
  onClose(): void;
}) {
  const spec = GATEWAY_PRESETS[preset];
  const [formats, setFormats] = useState<readonly GatewayFormat[]>(
    gateway?.formats ?? spec.formats
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!local || busy) return;
    const fields = new FormData(event.currentTarget);
    const apiKey = fields.get("apiKey");
    const base = new URL(
      (spec.transport === "loopback" && gateway?.baseUrl) || spec.baseUrl || "http://localhost"
    );
    if (spec.transport === "loopback") base.port = String(fields.get("port"));
    const baseUrl = spec.transport === "any" ? fields.get("baseUrl") : base.href;
    if (typeof baseUrl !== "string" || typeof apiKey !== "string") return;
    setBusy(true);
    setProblem("");
    try {
      await call(api.connectGateway, {
        preset,
        baseUrl,
        revision: gateway?.revision ?? null,
        apiKey: apiKey || undefined,
        formats: [...formats],
      });
      onClose();
    } catch (e) {
      setProblem(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        showCloseButton={!busy}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {gateway ? "Edit" : "Connect"} {spec.label}
          </DialogTitle>
          <DialogDescription>
            {spec.transport === "loopback"
              ? "Use a gateway running on this computer."
              : spec.transport === "any"
                ? "Enter the gateway’s base URL up to /v1 and its API key."
                : "Enter your OpenRouter API key."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={save} onChange={() => setProblem("")} className="grid gap-4">
          {spec.transport === "any" ? (
            <div className="grid gap-1.5">
              <Label htmlFor="gateway-base-url">Base URL</Label>
              <Input
                id="gateway-base-url"
                type="url"
                required
                name="baseUrl"
                defaultValue={gateway?.baseUrl ? gateway.baseUrl + "/v1" : spec.baseUrl}
                disabled={busy}
                placeholder="https://gateway.example/v1"
              />
            </div>
          ) : spec.transport === "loopback" ? (
            <div className="grid gap-1.5">
              <Label htmlFor="gateway-port">Local port</Label>
              <Input
                id="gateway-port"
                type="number"
                name="port"
                min={1}
                max={65535}
                required
                disabled={busy}
                defaultValue={
                  new URL(gateway?.baseUrl || spec.baseUrl).port ||
                  (gateway?.baseUrl.startsWith("https:") ? 443 : 80)
                }
              />
            </div>
          ) : (
            <p className="text-text-secondary text-sm">{spec.baseUrl}</p>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="gateway-api-key">API key</Label>
            <Input
              id="gateway-api-key"
              name="apiKey"
              type="password"
              autoComplete="off"
              required={!gateway}
              readOnly={busy}
              placeholder={gateway ? "Keep saved API key" : undefined}
            />
          </div>
          {!spec.formats.length && (
            <fieldset className="space-y-2">
              <legend className="mb-1 text-sm font-medium">API formats this gateway serves</legend>
              {(
                [
                  ["messages", "Anthropic Messages · Claude Code"],
                  ["responses", "OpenAI Responses · Codex"],
                ] as const
              ).map(([format, label]) => (
                <Label key={format} className="flex items-center gap-2">
                  <Switch
                    checked={formats.includes(format)}
                    disabled={busy}
                    onCheckedChange={(checked) =>
                      setFormats((current) =>
                        checked ? [...current, format] : current.filter((f) => f !== format)
                      )
                    }
                  />
                  {label}
                </Label>
              ))}
            </fieldset>
          )}
          {spec.rules && <ProviderRules rules={spec.rules} />}
          {problem && (
            <p role="alert" className="text-destructive text-sm">
              {problem}
            </p>
          )}
          <Button type="submit" disabled={busy || !formats.length} className="justify-self-end">
            {busy ? "Checking models…" : gateway ? "Save connection" : "Connect"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
