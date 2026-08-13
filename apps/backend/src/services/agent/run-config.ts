// backend/src/services/agent/run-config.ts
// Build the standard-wire TurnStartParams (input + RunConfig) for a deus
// turn. This is the backend-side successor of the agent-server's per-turn
// config assembly: prompt → engine input conversion, thinking-level mapping,
// system-prompt append, resume plumbing.

import type { AgentInput, RunConfig, TurnStartParams } from "@zvada/agent-server/protocol";
import type { AgentHarness } from "@shared/enums";
import type { ThinkingLevel, PermissionMode } from "@shared/protocol";
import { buildSystemPromptAppend } from "./system-prompt";

/** deus harness names → engine harness names. */
export const ENGINE_HARNESS = {
  claude: "claude-code",
  "codex-sdk": "codex-sdk",
  "codex-server": "codex-app-server",
} as const satisfies Record<AgentHarness, RunConfig["harness"]>;

/**
 * Deus's frontend serializes attachment-bearing prompts as a JSON array of
 * Anthropic content blocks (text / image with base64 or URL source). The
 * engine speaks its own PartInput vocabulary, so translate. Anything
 * unrecognized stays text.
 */
export function toEngineInput(prompt: string): AgentInput {
  if (!prompt.startsWith("[")) return prompt;
  let blocks: unknown;
  try {
    blocks = JSON.parse(prompt);
  } catch {
    return prompt;
  }
  if (!Array.isArray(blocks) || blocks.length === 0) return prompt;
  const parts: Extract<AgentInput, unknown[]> = [];
  for (const block of blocks as Array<Record<string, unknown>>) {
    if (block?.type === "text" && typeof block.text === "string") {
      parts.push({ type: "text", text: block.text });
      continue;
    }
    if (block?.type === "image") {
      const source = block.source as
        | { type?: string; url?: string; media_type?: string; data?: string }
        | undefined;
      if (source?.type === "url" && source.url) {
        parts.push({ type: "image", url: source.url, mediaType: source.media_type ?? "image/png" });
        continue;
      }
      if (source?.data) {
        parts.push({
          type: "image",
          data: source.data,
          mediaType: source.media_type ?? "image/png",
        });
        continue;
      }
    }
    // Unknown block type — not a content array we understand; keep raw text.
    return prompt;
  }
  return parts.length ? parts : prompt;
}

/**
 * The codex harnesses take text-only input (the engine's codex adapters drop
 * image parts) — replace images with an explicit marker so the model knows an
 * attachment existed instead of it vanishing silently.
 */
export function withoutImageParts(input: AgentInput): AgentInput {
  if (typeof input === "string") return input;
  return input.map((part) =>
    part.type === "image"
      ? {
          type: "text" as const,
          text: "[attached image omitted — this model harness does not support image input]",
        }
      : part
  );
}

/** deus UPPERCASE thinking levels → engine lowercase. */
export function toEngineThinking(
  level: ThinkingLevel | undefined
): "off" | "low" | "medium" | "high" | "xhigh" | undefined {
  switch (level) {
    case "NONE":
      return "off";
    case "LOW":
      return "low";
    case "MEDIUM":
      return "medium";
    case "HIGH":
      return "high";
    case "XHIGH":
      return "xhigh";
    default:
      return undefined;
  }
}

export interface DeusTurnOptions {
  cwd: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  permissionMode?: PermissionMode;
  maxTurns?: number;
  additionalDirectories?: string[];
  /** Native session id to resume (sessions.agent_session_id). */
  resume?: string;
  /** Checkpoint revert: fork the resumed session at a specific message. */
  resumeSessionAt?: string;
}

/** Assemble the wire params for one turn (ids are minted by the caller). */
export function buildTurnStartParams(
  sessionId: string,
  turnId: string,
  agentHarness: AgentHarness,
  prompt: string,
  options: DeusTurnOptions
): TurnStartParams {
  const input = toEngineInput(prompt);
  return {
    sessionId,
    turnId,
    input: agentHarness === "claude" ? input : withoutImageParts(input),
    config: {
      harness: ENGINE_HARNESS[agentHarness],
      cwd: options.cwd,
      model: options.model,
      thinkingLevel: toEngineThinking(options.thinkingLevel),
      systemPromptAppend: buildSystemPromptAppend(agentHarness, options.cwd),
      // Verbatim — the engine speaks dontAsk natively (never-prompt without
      // the dangerous bypass, which also disables Claude extended thinking).
      permissionMode: options.permissionMode,
      maxTurns: options.maxTurns ?? 1000,
      additionalDirectories: options.additionalDirectories,
      resumeSessionId: options.resume,
      resumeSessionAt: options.resumeSessionAt,
    },
  };
}
