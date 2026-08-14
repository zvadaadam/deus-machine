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
 * The composer speaks the canonical `PartInput` vocabulary: a text-only send
 * is a bare string (already an `AgentInput`), an attachment-bearing send is a
 * JSON-encoded `PartInput[]`. This is a passthrough for both — it only decodes
 * the JSON envelope and validates the parts.
 *
 * The one translation left is TOLERANCE: rows written before the composer was
 * flipped hold Anthropic content blocks (`{type:"image",source:{…}}`). Those
 * are converted rather than rejected, so re-sent history still works. Anything
 * unrecognized stays plain text — a prompt that merely starts with "[" must
 * not be mangled.
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
  for (const block of blocks) {
    const part = toPartInput(block);
    // Not a parts array we understand (a JSON list of something else) — the
    // prompt was never structured input, so keep the raw text.
    if (part === UNRECOGNIZED) return prompt;
    if (part) parts.push(part);
  }
  return parts.length ? parts : prompt;
}

/** Distinguishes "drop this part" (null) from "this isn't a parts array". */
const UNRECOGNIZED = Symbol("unrecognized-block");

function toPartInput(block: unknown): PartInput | null | typeof UNRECOGNIZED {
  if (!block || typeof block !== "object" || Array.isArray(block)) return UNRECOGNIZED;
  const record = block as Record<string, unknown>;

  if (record.type === "text" && typeof record.text === "string") {
    // A text part must be non-empty on the wire; an empty one carries nothing.
    return record.text.length > 0 ? (record as unknown as PartInput) : null;
  }

  if (record.type === "image" || record.type === "file") {
    // LEGACY: Anthropic's nested `source`, flattened to the canonical shape.
    const source = record.source as
      | { type?: string; url?: string; media_type?: string; data?: string }
      | undefined;
    if (source) {
      const mimeType = source.media_type ?? "image/png";
      if (source.url) return { type: "image", url: source.url, mimeType };
      if (source.data) return { type: "image", data: source.data, mimeType };
      return UNRECOGNIZED;
    }
    // Canonical: flat `data` | `url` + `mimeType` — forwarded verbatim.
    const hasPayload = typeof record.data === "string" || typeof record.url === "string";
    if (hasPayload && typeof record.mimeType === "string") {
      return record as unknown as PartInput;
    }
  }

  return UNRECOGNIZED;
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
