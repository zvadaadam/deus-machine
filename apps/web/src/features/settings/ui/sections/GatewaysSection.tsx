import { useRef, useState, type SyntheticEvent } from "react";
import { Ellipsis, Plus } from "lucide-react";
import { api } from "@shared/api";
import {
  GATEWAY_PRESETS,
  GATEWAY_PRESET_IDS,
  gatewayLabel,
  type GatewayPreset,
  type GatewayStatus,
} from "@shared/gateways";
import { getErrorMessage } from "@shared/lib/errors";
import { GatewayLogo } from "@/shared/agents/GatewayLogo";
import { Button } from "@/components/ui/button";
import { Glide } from "@/components/ui/glide";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { call } from "@/platform/ws";
import { GatewayDisclosure } from "./GatewayDisclosure";
import { useGateways } from "@/shared/hooks/useGateways";
import { GatewayForm, ProviderRules } from "./GatewayForm";
import { StatusDot } from "./ProviderRow";

export function GatewaysSection({
  local,
  recheck,
  checking,
}: {
  local: boolean;
  recheck: (gateway: GatewayStatus) => Promise<void>;
  checking: boolean;
}) {
  const { data: gateways, error } = useGateways();
  const [editing, setEditing] = useState<{ preset: GatewayPreset; gateway?: GatewayStatus }>();
  const [problem, setProblem] = useState("");
  const dialogTrigger = useRef<HTMLButtonElement | null>(null);
  function rememberTrigger(event: SyntheticEvent<HTMLButtonElement>) {
    dialogTrigger.current = event.currentTarget;
  }
  const triggerEvents = { onFocus: rememberTrigger, onPointerDown: rememberTrigger };
  function edit(preset: GatewayPreset, gateway?: GatewayStatus) {
    setProblem("");
    setEditing({ preset, gateway });
  }
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
              {GATEWAY_PRESET_IDS.map((preset) => (
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
                  {!offline && (
                    <DropdownMenuItem disabled={checking} onSelect={retry}>
                      {g.problem ? "Retry" : "Refresh models"}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem onSelect={() => edit(g.preset, g)}>
                    Edit connection
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() =>
                      void call(api.disconnectGateway, { revision: g.revision }).catch((e) =>
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
                key={g.revision}
                connection={g}
                row={{
                  icon: <GatewayLogo preset={g.preset} className="size-5" />,
                  name: (
                    <>
                      {name}
                      {g.baseUrl && name === preset.label && (
                        <span className="text-text-secondary font-normal">
                          {" "}
                          · {new URL(g.baseUrl).host}
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
          {error?.message || (gateways ? "No gateways connected" : "Reading gateways…")}
        </p>
      )}
      {!local && <p className="text-text-muted text-xs">Manage gateways on this computer.</p>}
      {!editing && problem && (
        <p role="alert" className="text-destructive text-sm">
          {problem}
        </p>
      )}
      {editing && (
        <GatewayForm
          {...editing}
          local={local}
          returnFocus={() => dialogTrigger.current?.focus()}
          onClose={() => setEditing(undefined)}
        />
      )}
    </section>
  );
}
