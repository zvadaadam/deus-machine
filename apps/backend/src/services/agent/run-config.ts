// backend/src/services/agent/run-config.ts
// Build the standard-wire TurnStartParams (input + RunConfig) for a deus
// turn. This is the backend-side successor of the agent-server's per-turn
// config assembly: prompt → engine input conversion, thinking-level mapping,
// system-prompt append, resume plumbing.

import { parseAgentInput } from "@zvada/agent-server/protocol";
import type { AgentInput, TurnStartParams } from "@zvada/agent-server/protocol";
import type { AgentHarness } from "@shared/enums";
import type { ThinkingLevel, PermissionMode } from "@shared/protocol";
import { buildSystemPromptAppend } from "./system-prompt";

/**
 * The composer speaks the canonical `PartInput` vocabulary: a text-only send is
 * a bare string (already an `AgentInput`), an attachment-bearing send is a
 * JSON-encoded `PartInput[]`. The parts themselves are the engine's own — the
 * schema decides whether they are valid, not a decoder in front of it.
 *
 * What is left here is not translation but DISAMBIGUATION, which the engine
 * cannot do for us: deus's wire carries the prompt as one `string`, so "a JSON
 * array of parts" and "prose that happens to start with `[`" arrive
 * identically. A markdown link (`[see this](…)`), a typed `[1, 2, 3]`, an
 * empty `[]` — each is text the user wants the model to read, and mangling it
 * into structured input (or refusing the send) is worse than sending it
 * verbatim. Only a `[`-prefixed value that parses as JSON AND validates as
 * `AgentInput` is treated as structured; everything else is the prompt.
 */
export function toEngineInput(prompt: string): AgentInput {
  if (!prompt.startsWith("[")) return prompt;
  let decoded: unknown;
  try {
    decoded = JSON.parse(prompt);
  } catch {
    return prompt;
  }
  // An empty array carries nothing; the literal "[]" is what the user typed.
  if (!Array.isArray(decoded) || decoded.length === 0) return prompt;
  try {
    return parseAgentInput(decoded);
  } catch (error) {
    // Logged, not swallowed: prose is the common case, but a composer bug that
    // emits almost-canonical parts would otherwise ship JSON to the model with
    // nothing written anywhere.
    console.warn(`[RunConfig] '['-prefixed prompt is not AgentInput, sending as text:`, error);
    return prompt;
  }
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
