// agent-server/agents/codex-server/codex-server-config.ts
// Codex app-server request builders and stable Deus defaults.

import type { QueryOptions } from "../registry";
import { parseThinkingLevel } from "../thinking-levels";
import type {
  CodexReasoningEffort,
  CodexSandboxPolicy,
  CodexThreadStartParams,
  CodexTurnStartParams,
} from "./codex-server-types";

export function buildCodexThreadParams(
  options: QueryOptions,
  workspaceContext: string
): CodexThreadStartParams {
  return {
    model: options.model ?? null,
    cwd: options.cwd,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    developerInstructions: workspaceContext || null,
    config: {
      "features.collaboration_modes": true,
      "features.goals": true,
    },
  };
}

export function buildCodexTurnStartParams(
  options: QueryOptions,
  params: {
    threadId: string;
    prompt: string;
    effort: CodexReasoningEffort | null;
  }
): CodexTurnStartParams {
  return {
    threadId: params.threadId,
    input: [{ type: "text", text: params.prompt, text_elements: [] }],
    cwd: options.cwd,
    approvalPolicy: "never",
    sandboxPolicy: buildWorkspaceWriteSandbox(options),
    model: options.model,
    effort: params.effort,
    summary: "auto",
  };
}

export function buildWorkspaceWriteSandbox(options: QueryOptions): CodexSandboxPolicy {
  return {
    type: "workspaceWrite",
    writableRoots: [options.cwd, ...(options.additionalDirectories ?? [])],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

export function mapCodexThinkingLevel(
  level: QueryOptions["thinkingLevel"]
): CodexReasoningEffort | null {
  const parsed = parseThinkingLevel(level, "Codex");
  switch (parsed) {
    case "NONE":
      return "none";
    case "LOW":
      return "low";
    case "MEDIUM":
      return "medium";
    case "HIGH":
      return "high";
    case "XHIGH":
      return "xhigh";
    default:
      return null;
  }
}
