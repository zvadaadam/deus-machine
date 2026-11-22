/**
 * Agent logos — SVG React components via SVGR
 *
 * Uses vite-plugin-svgr to import SVGs as React components.
 * Icons render inline in the DOM so `currentColor` works natively
 * and sizing is controlled via className (e.g., `w-5 h-5`).
 */
import { AgentHarnessSchema, type AgentHarness } from "@shared/enums";
import type { FC, SVGProps } from "react";

import ClaudeCode from "./claude-code.svg?react";
import Codex from "./codex.svg?react";
import Gemini from "./gemini.svg?react";

export type AgentLogoComponent = FC<SVGProps<SVGSVGElement>>;

/** Agent harness → its logo. */
const agentLogos: Record<AgentHarness, AgentLogoComponent> = {
  "claude-code": ClaudeCode,
  "codex-app-server": Codex,
  gemini: Gemini,
};

/** Get agent logo component, returns undefined if not found */
export function getAgentLogo(agentHarness: string): AgentLogoComponent | undefined {
  const id = AgentHarnessSchema.safeParse(agentHarness.toLowerCase());
  return id.success ? agentLogos[id.data] : undefined;
}
