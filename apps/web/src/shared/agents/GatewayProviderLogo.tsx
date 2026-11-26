import { Layers3 } from "lucide-react";
import { getAgentLogo } from "@/assets/agents";
import { gatewayProvider } from "@shared/gateways";

export function GatewayProviderLogo({ provider }: { provider: string }) {
  const { logo } = gatewayProvider(provider);
  const Icon = (logo && getAgentLogo(logo)) || Layers3;
  return <Icon aria-hidden="true" className="size-3.5 shrink-0" />;
}
