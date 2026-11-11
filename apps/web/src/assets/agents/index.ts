/**
 * Agent logos — SVG React components via SVGR
 *
 * Uses vite-plugin-svgr to import SVGs as React components.
 * Icons render inline in the DOM so `currentColor` works natively
 * and sizing is controlled via className (e.g., `w-5 h-5`).
 */
import type { FC, SVGProps } from "react";

import ClaudeCode from "./claude-code.svg?react";
import Codex from "./codex.svg?react";

export type AgentLogoComponent = FC<SVGProps<SVGSVGElement>>;

/** Agent harness (and the spellings older rows saved) → its logo. */
const agentLogos: Record<string, AgentLogoComponent> = {
  "claude-code": ClaudeCode,
  claude: ClaudeCode,
  "codex-sdk": Codex,
  "codex-app-server": Codex,
  "codex-server": Codex,
};

/** Get agent logo component, returns undefined if not found */
export function getAgentLogo(agentHarness: string): AgentLogoComponent | undefined {
  return agentLogos[agentHarness.toLowerCase()];
}
