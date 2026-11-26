import { useRef, useState, type FormEvent, type SyntheticEvent } from "react";
import { Ellipsis, Plus } from "lucide-react";
import { api } from "@shared/api";
import {
  GATEWAY_PRESETS,
  GATEWAY_KINDS,
  gatewayLabel,
  type GatewayFormat,
  type GatewayKind,
  type GatewayStatus,
} from "@shared/gateways";
import { getErrorMessage } from "@shared/lib/errors";
import { GatewayLogo } from "@/shared/agents/GatewayLogo";
import { Button } from "@/components/ui/button";
import { Glide } from "@/components/ui/glide";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { openExternal } from "@/platform/native/window";
import { call } from "@/platform/ws";
import { GatewayDisclosure } from "./GatewayDisclosure";
import { StatusDot } from "./ProviderRow";

function ProviderRules({
  rules,
}: {
  rules: NonNullable<(typeof GATEWAY_PRESETS)[GatewayKind]["rules"]>;
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

export function GatewaysSection({
  gateways,
  error,
  local,
  recheck,
  checking,
}: {
  gateways?: GatewayStatus[];
  error?: string;
  local: boolean;
  recheck: (gateway: GatewayStatus) => Promise<void>;
  checking: boolean;
}) {
  const [editing, setEditing] = useState<{ preset: GatewayKind; gateway?: GatewayStatus }>();
  const [formats, setFormats] = useState<readonly GatewayFormat[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const dialogTrigger = useRef<HTMLButtonElement | null>(null);
  function rememberTrigger(event: SyntheticEvent<HTMLButtonElement>) {
    dialogTrigger.current = event.currentTarget;
  }
  const triggerEvents = { onFocus: rememberTrigger, onPointerDown: rememberTrigger };
  function edit(preset: GatewayKind, gateway?: GatewayStatus) {
    setFormats(gateway?.formats ?? GATEWAY_PRESETS[preset].formats);
    setProblem("");
    setEditing({ preset, gateway });
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing || !local || busy) return;
    const fields = new FormData(event.currentTarget);
    const key = fields.get("key");
    const spec = GATEWAY_PRESETS[editing.preset];
    const base = new URL(
      (spec.transport === "loopback" && editing.gateway?.address) ||
        spec.address ||
        "http://localhost"
    );
    if (spec.transport === "loopback") base.port = String(fields.get("port"));
    const address = spec.transport === "any" ? fields.get("address") : base.href;
    if (typeof address !== "string" || typeof key !== "string") return;
    setBusy(true);
    setProblem("");
    try {
      await call(api.connectGateway, {
        preset: editing.preset,
        address,
        generation: editing.gateway?.generation ?? null,
        clientKey: key || undefined,
        formats: [...formats],
      });
      setEditing(undefined);
    } catch (e) {
      setProblem(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const spec = editing && GATEWAY_PRESETS[editing.preset];
  return (
    <section aria-label="Gateways">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-muted-foreground text-xs font-medium">Gateways</h4>
        {local && (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="xs" {...triggerEvents}>
                <Plus aria-hidden className="size-3.5" />
                Add gateway
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {GATEWAY_KINDS.map((preset) => (
                <DropdownMenuItem key={preset} onSelect={() => edit(preset)}>
                  <GatewayLogo preset={preset} className="size-4" />
                  {GATEWAY_PRESETS[preset].label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <div className="relative isolate">
        {/* The details selector clears the hover fill when the pointer leaves the rows. */}
        <Glide
          rows="[data-provider-row],[data-gateway-details]"
          selected="[data-gateway-details]"
          className="bg-accent rounded-[calc(var(--radius-xl)-var(--spacing))]"
        />
        {gateways?.map((g) => {
          const preset = GATEWAY_PRESETS[g.preset];
          const name = gatewayLabel(g, gateways);
          const offline = g.problem?.kind === "unreachable";
          const retry = () => void recheck(g).catch((e) => setProblem(getErrorMessage(e)));
          const action = local && (
            <div className="flex items-center gap-1">
              {offline && (
                <Button variant="outline" size="xs" onClick={retry} disabled={checking}>
                  Retry
                </Button>
              )}
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={name + " options"}
                    className="data-[state=open]:bg-control-pressed size-8 pointer-coarse:size-11"
                    {...triggerEvents}
                  >
                    <Ellipsis className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {g.problem && !offline && (
                    <DropdownMenuItem disabled={checking} onSelect={retry}>
                      Retry
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onSelect={() => edit(g.preset, g)}>
                    Edit connection
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() =>
                      void call(api.disconnectGateway, { generation: g.generation }).catch((e) =>
                        setProblem(getErrorMessage(e))
                      )
                    }
                  >
                    Disconnect
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
          return (
            <div
              key={g.ref}
              className="border-border-subtle border-t pb-2 first-of-type:border-t-0"
            >
              <GatewayDisclosure
                key={g.generation}
                connection={g}
                onOpen={local ? retry : undefined}
                row={{
                  icon: <GatewayLogo preset={g.preset} className="size-5" />,
                  name: (
                    <>
                      {name}
                      {g.address && name === preset.label && (
                        <span className="text-text-secondary font-normal">
                          {" "}
                          · {new URL(g.address).host}
                        </span>
                      )}
                    </>
                  ),
                  status: (
                    <StatusDot tone={g.problem ? "warn" : "ready"}>
                      {g.problem ? (offline ? "Not reachable" : "Needs attention") : "Connected"}
                    </StatusDot>
                  ),
                  action,
                }}
              />
              {preset.rules && <ProviderRules rules={preset.rules} />}
            </div>
          );
        })}
      </div>
      {!gateways?.length && (
        <p className="text-text-muted py-2 text-sm">
          {error || (gateways ? "No gateways connected" : "Reading gateways…")}
        </p>
      )}
      {!local && <p className="text-text-muted text-xs">Manage gateways on this computer.</p>}
      {!editing && problem && (
        <p role="alert" className="text-destructive text-sm">
          {problem}
        </p>
      )}
      <Dialog
        open={!!editing}
        onOpenChange={(open) => {
          if (!open && !busy) {
            setEditing(undefined);
            setProblem("");
          }
        }}
      >
        {editing && spec && (
          <DialogContent
            showCloseButton={!busy}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              dialogTrigger.current?.focus();
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {editing.gateway ? "Edit" : "Connect"} {spec.label}
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
                  <Label htmlFor="gateway-address">Base URL</Label>
                  <Input
                    id="gateway-address"
                    type="url"
                    required
                    name="address"
                    defaultValue={
                      editing.gateway?.address ? editing.gateway.address + "/v1" : spec.address
                    }
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
                      new URL(editing.gateway?.address || spec.address).port ||
                      (editing.gateway?.address.startsWith("https:") ? 443 : 80)
                    }
                  />
                </div>
              ) : (
                <p className="text-text-secondary text-sm">{spec.address}</p>
              )}
              <div className="grid gap-1.5">
                <Label htmlFor="gateway-key">
                  {spec.transport === "loopback" ? "Client key" : "API key"}
                </Label>
                <Input
                  id="gateway-key"
                  name="key"
                  type="password"
                  autoComplete="off"
                  required={!editing.gateway}
                  readOnly={busy}
                  placeholder={editing.gateway ? "Keep saved key" : undefined}
                />
              </div>
              {!spec.formats.length && (
                <fieldset className="space-y-2">
                  <legend className="mb-1 text-sm font-medium">
                    API formats this gateway serves
                  </legend>
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
                {busy ? "Checking models…" : editing.gateway ? "Save connection" : "Connect"}
              </Button>
            </form>
          </DialogContent>
        )}
      </Dialog>
    </section>
  );
}
