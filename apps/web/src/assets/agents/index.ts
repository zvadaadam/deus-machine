/**
 * Agent logos — SVG React components via SVGR
 *
 * Uses vite-plugin-svgr to import SVGs as React components.
 * Icons render inline in the DOM so `currentColor` works natively
 * and sizing is controlled via className (e.g., `w-5 h-5`).
 */
import type { FC, SVGProps } from "react";

import Amp from "./amp.svg?react";
import Antigravity from "./antigravity.svg?react";
import ClaudeCode from "./claude-code.svg?react";
import Clawdbot from "./clawdbot.svg?react";
import Cline from "./cline.svg?react";
import Codex from "./codex.svg?react";
import Copilot from "./copilot.svg?react";
import Cursor from "./cursor.svg?react";
import Droid from "./droid.svg?react";
import Gemini from "./gemini.svg?react";
import Goose from "./goose.svg?react";
import Kilo from "./kilo.svg?react";
import KiroCli from "./kiro-cli.svg?react";
import Opencode from "./opencode.svg?react";
import Roo from "./roo.svg?react";
import Trae from "./trae.svg?react";
import Vscode from "./vscode.svg?react";
import Windsurf from "./windsurf.svg?react";

export type AgentLogoComponent = FC<SVGProps<SVGSVGElement>>;

/** Map of agent type/name → SVG React component */
export const agentLogos: Record<string, AgentLogoComponent> = {
  amp: Amp,
  antigravity: Antigravity,
  "claude-code": ClaudeCode,
  claude: ClaudeCode,
  clawdbot: Clawdbot,
  cline: Cline,
  codex: Codex,
  copilot: Copilot,
  "github-copilot": Copilot,
  cursor: Cursor,
  droid: Droid,
  gemini: Gemini,
  goose: Goose,
  kilo: Kilo,
  "kiro-cli": KiroCli,
  kiro: KiroCli,
  opencode: Opencode,
  roo: Roo,
  trae: Trae,
  vscode: Vscode,
  windsurf: Windsurf,
};

/** Get agent logo component, returns undefined if not found */
export function getAgentLogo(agentHarness: string): AgentLogoComponent | undefined {
  return agentLogos[agentHarness.toLowerCase()];
}
