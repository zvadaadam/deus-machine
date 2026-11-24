import { answerParts } from "../../lib/assistantTurnContent";
import type { Message, SessionTurn } from "@/shared/types";
import type { TokenUsage } from "@shared/protocol-types";

export interface TurnFooterData {
  attribution?: Pick<SessionTurn, "execution" | "providerCredentialSource">;
  copyText: string | null;
  startedAt: number | null;
  durationMs: number | null;
  /** Billed tokens for the turn (turn.ended), when the harness reported them. */
  tokens: TokenUsage | null;
  /** USD for the turn, when reported. */
  cost: number | null;
}

export function getTurnFooterData(
  groups: Message[][],
  startedAt?: string | null,
  turn?: SessionTurn
): TurnFooterData {
  const start = turn?.startedAt ?? parseTimestamp(startedAt);
  const end = turn?.endedAt ?? getTurnEndMs(groups.flat());
  return {
    attribution:
      turn?.execution || turn?.providerCredentialSource
        ? {
            execution: turn.execution,
            providerCredentialSource: turn.providerCredentialSource,
          }
        : undefined,
    copyText:
      groups
        .flatMap((group) => answerParts(group.flatMap((message) => message.parts ?? [])))
        .map((part) => part.text.trim())
        .join("\n\n") || null,
    startedAt: start,
    durationMs: start != null && end != null && end >= start ? end - start : null,
    tokens: turn?.tokens ?? null,
    cost: turn?.cost ?? null,
  };
}

function getTurnEndMs(messages: Message[]): number | null {
  let latestEndMs: number | null = null;

  for (const message of messages) {
    latestEndMs = getLatestTimestamp(latestEndMs, message.sent_at);

    for (const part of message.parts ?? []) {
      if ("raw" in part) continue;

      // Protocol times are epoch ms; the message columns stay ISO strings.
      if (part.type === "reasoning") {
        latestEndMs = maxEpochMs(latestEndMs, part.time?.end);
        continue;
      }

      if (part.type === "tool" && part.state.status !== "pending") {
        const time = part.state.time;
        latestEndMs = maxEpochMs(latestEndMs, "end" in time ? time.end : undefined);
      }
    }
  }

  return latestEndMs;
}

function getLatestTimestamp(
  current: number | null,
  ...values: Array<string | null | undefined>
): number | null {
  let latest = current;

  for (const value of values) {
    const timestamp = parseTimestamp(value);
    if (timestamp == null) continue;
    latest = latest == null ? timestamp : Math.max(latest, timestamp);
  }

  return latest;
}

/** Fold an epoch-ms stamp into the running max. */
function maxEpochMs(current: number | null, value?: number): number | null {
  if (value === undefined || !Number.isFinite(value)) return current;
  return current == null ? value : Math.max(current, value);
}

function parseTimestamp(value?: string | null): number | null {
  if (!value) return null;

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}
