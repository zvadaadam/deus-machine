import { useState, type ComponentProps, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { gatewaySupports, type GatewayStatus, type GatewayModel } from "@shared/gateways";
import { Button } from "@/components/ui/button";
import { providerGroups } from "@/shared/agents/picker";
import { GatewayProviderLogo } from "@/shared/agents/GatewayProviderLogo";
import { ProviderRow } from "./ProviderRow";
import { cn } from "@/shared/lib/utils";

function DisclosureButton({
  expanded,
  onClick,
  children,
}: {
  expanded: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      aria-expanded={expanded}
      onClick={onClick}
      className="hover:bg-accent focus-visible:ring-ring flex w-full min-w-0 items-center gap-2 rounded-sm px-1 py-1.5 text-left text-sm focus-visible:ring-2 pointer-coarse:min-h-11"
    >
      <ChevronRight className={cn("size-3 shrink-0", expanded && "rotate-90")} />
      {children}
    </button>
  );
}

export function GatewayDisclosure({
  connection,
  onOpen,
  row,
}: {
  connection: GatewayStatus;
  onOpen?(): void;
  row: ComponentProps<typeof ProviderRow>;
}) {
  const { models } = connection;
  const [expanded, setExpanded] = useState(false);
  const [provider, setProvider] = useState<string>();
  const [all, setAll] = useState(false);
  const [modelId, setModelId] = useState<string>();
  const available = (model: GatewayModel) =>
    gatewaySupports(connection, model, "claude-code") ||
    gatewaySupports(connection, model, "codex-app-server");
  const chatCount = models.filter(available).length;
  const count = models.length + (models.length === 1 ? " model" : " models");
  return (
    <>
      <div className="rounded-xl p-1">
        <ProviderRow
          {...row}
          disclosure={{
            expanded,
            toggle: () => {
              if (!expanded) onOpen?.();
              setExpanded(!expanded);
            },
          }}
          detail={connection.problem?.message || (chatCount ? count : count + " · No chat models")}
        />
      </div>
      {expanded && (
        <div data-gateway-details="" className="border-border-subtle mb-3 ml-3 border-l pl-4">
          <div className="text-text-muted flex justify-between gap-2 py-2 text-xs">
            <span>Models</span>
            <span>
              {chatCount} for chat · {models.length} total
            </span>
          </div>
          {providerGroups(models).map(([name, rows]) => (
            <div key={name}>
              <DisclosureButton
                expanded={provider === name}
                onClick={() => {
                  setProvider(provider === name ? undefined : name);
                  setModelId(undefined);
                  setAll(false);
                }}
              >
                <GatewayProviderLogo provider={rows[0]!.provider} />
                <span>{name}</span>
                <span className="text-text-muted ml-auto text-xs">
                  {rows.filter(available).length} for chat · {rows.length} total
                </span>
              </DisclosureButton>
              {provider === name && (
                <div className="pl-5">
                  {(all ? rows : rows.slice(0, 6)).map((m) => (
                    <div key={m.id}>
                      <DisclosureButton
                        expanded={modelId === m.id}
                        onClick={() => {
                          setModelId(modelId === m.id ? undefined : m.id);
                        }}
                      >
                        <span className="break-words">{m.label}</span>
                      </DisclosureButton>
                      {modelId === m.id && (
                        <div className="text-text-secondary space-y-1 pb-2 pl-6 text-xs">
                          <code className="break-all">{m.id}</code>
                          <p>
                            {available(m)
                              ? "Available for chat"
                              : m.excluded === "hidden"
                                ? "Hidden in the picker"
                                : m.excluded === "non_chat"
                                  ? "Unavailable for chat"
                                  : "Chat support unknown"}
                          </p>
                        </div>
                      )}
                    </div>
                  ))}
                  {!all && rows.length > 6 && (
                    <Button variant="ghost" size="xs" onClick={() => setAll(true)}>
                      Show all {rows.length}
                    </Button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
