import { Network, Split } from "lucide-react";
import type { GatewayPreset } from "@shared/gateways";
import CLIProxyAPIMark from "@/assets/agents/cliproxyapi.svg?react";

const marks = { openrouter: Split, cliproxyapi: CLIProxyAPIMark, custom: Network };

export function GatewayLogo({ preset, className }: { preset: GatewayPreset; className?: string }) {
  const Mark = marks[preset];
  return <Mark aria-hidden className={className} />;
}
