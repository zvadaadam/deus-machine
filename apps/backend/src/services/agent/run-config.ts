// backend/src/services/agent/run-config.ts
// Build the standard-wire TurnStartParams (input + RunConfig) for a deus
// turn. This is the backend-side successor of the agent-server's per-turn
// config assembly: prompt → engine input conversion, thinking-level mapping,
// system-prompt append, resume plumbing.

import type { AgentInput, PartInput, TurnStartParams } from "@zvada/agent-server/protocol";
import type { AgentHarness } from "@shared/enums";
import type { ThinkingLevel, PermissionMode } from "@shared/protocol";
import { buildSystemPromptAppend } from "./system-prompt";

/**
 * Attachment-bearing prompts still arrive from the composer as a JSON array of
 * Anthropic content blocks; parse them into canonical `PartInput[]`. Anything
 * unrecognized stays plain text — a prompt that merely starts with "[" must
 * not be mangled.
 *
 * (Once the composer composes PartInput directly this collapses to a
 * passthrough; the wire vocabulary below is already the destination shape.)
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
  const parts: PartInput[] = [];
  for (const block of blocks as Array<Record<string, unknown>>) {
    if (block?.type === "text" && typeof block.text === "string") {
      // A text part must be non-empty on the wire; an empty block carries
      // nothing anyway.
      if (block.text.length > 0) parts.push({ type: "text", text: block.text });
      continue;
    }
    if (block?.type === "image") {
      const source = block.source as
        | { type?: string; url?: string; media_type?: string; data?: string }
        | undefined;
      if (source?.type === "url" && source.url) {
        parts.push({ type: "image", url: source.url, mimeType: source.media_type ?? "image/png" });
        continue;
      }
      if (source?.data) {
        parts.push({
          type: "image",
          data: source.data,
          mimeType: source.media_type ?? "image/png",
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
 * Drop image parts for harnesses that can't accept them, replacing each with
 * an explicit marker so the model knows an attachment existed instead of it
 * vanishing silently. Keyed off the negotiated `capabilities.images`, never a
 * hardcoded harness list.
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
  /** From the initialize handshake — whether this harness accepts image parts. */
  supportsImages?: boolean;
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
    input: options.supportsImages ? input : withoutImageParts(input),
    config: {
      // The harness id IS the engine's — no alias map in between.
      harness: agentHarness,
      cwd: options.cwd,
      model: options.model,
      thinkingLevel: options.thinkingLevel,
      systemPromptAppend: buildSystemPromptAppend(agentHarness, options.cwd),
      // Verbatim — deus and the engine speak the same permission vocabulary
      // (dont_ask = never prompt, without the dangerous bypass that also
      // disables Claude extended thinking).
      permissionMode: options.permissionMode,
      maxTurns: options.maxTurns ?? 1000,
      additionalDirectories: options.additionalDirectories,
      resumeSessionId: options.resume,
      resumeSessionAt: options.resumeSessionAt,
    },
  };
}
