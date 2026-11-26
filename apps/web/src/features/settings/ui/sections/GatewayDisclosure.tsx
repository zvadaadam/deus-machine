import { useState, type ComponentProps } from "react";
import { gatewaySupports, type GatewayStatus, type GatewayModel } from "@shared/gateways";
import { HARNESSES, LOCAL_HARNESSES } from "@shared/harnesses";
import { providerGroups } from "@/shared/agents/picker";
import { GatewayProviderLogo } from "@/shared/agents/GatewayProviderLogo";
import { ProviderRow } from "./ProviderRow";

export function GatewayDisclosure({
  connection,
  row,
}: {
  connection: GatewayStatus;
  row: ComponentProps<typeof ProviderRow>;
}) {
  const { models } = connection;
  const [expanded, setExpanded] = useState(false);
  const agentsFor = (model: GatewayModel) =>
    LOCAL_HARNESSES.filter((harness) => gatewaySupports(connection, model, harness));
  const hasChat = models.some((model) => agentsFor(model).length > 0);
  const count = models.length + (models.length === 1 ? " model" : " models");
  return (
    <>
      <div className="rounded-xl p-1">
        <ProviderRow
          {...row}
          disclosure={{ expanded, toggle: () => setExpanded(!expanded) }}
          detail={connection.problem?.message || (hasChat ? count : count + " · No chat models")}
        />
      </div>
      {expanded && (
        <div
          data-gateway-details=""
          className="border-border-subtle mb-3 ml-3 space-y-3 border-l pl-4"
        >
          {providerGroups(models).map(([name, rows]) => (
            <div key={name}>
              <h5 className="text-text-secondary flex items-center gap-2 py-1 text-xs font-medium">
                <GatewayProviderLogo provider={rows[0]!.provider} />
                {name}
              </h5>
              <ul className="pl-5">
                {rows.map((model) => (
                  <li key={model.id} className="flex items-baseline justify-between gap-3 py-1">
                    <span className="min-w-0 text-sm break-words">
                      {model.label}
                      {model.label !== model.id && (
                        <code className="text-text-muted block text-xs break-all">{model.id}</code>
                      )}
                    </span>
                    <span className="text-text-muted shrink-0 text-xs">
                      {agentsFor(model)
                        .map((harness) => HARNESSES[harness].label)
                        .join(", ") || "Not offered in chat"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
