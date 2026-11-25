import type { Origin, TurnCancelResult, TurnEndedEvent } from "@zvada/agent-server/protocol";
import { invalidate } from "../query-engine";
import {
  persistSessionError,
  persistStopCredit,
  persistStopStatus,
  persistTurn,
  restoreEndedStatus,
  type TurnOutcomeWrite,
} from "./persistence";

type NativeEnd = {
  type: "end";
  turnId: string;
  held: boolean;
  cancelled: boolean;
  status?: TurnOutcomeWrite["status"];
  limit?: { resetsAt?: number };
};
export type TurnNotice =
  | NativeEnd
  | { type: "stop"; turnId?: string; by: Origin }
  | { type: "interrupted"; turnId?: string; gone: boolean; cause: "failure" | "cancelled" }
  | { type: "available" };
export const turnNotices: {
  queue?: (id: string, notice: TurnNotice) => string[] | undefined;
  withdrawCards?: (id: string, turnId: string) => void;
  stored?: (id: string, turnId: string) => void;
} = {};
type Setup = {
  controller: AbortController;
  done: Promise<void>;
};
type Turn = {
  turnId: string;
  phase: "preparing" | "starting" | "running";
  sentAt?: number;
  lastOutputAt?: number;
  setup?: Setup;
  stops?: Set<Origin>;
  credited?: Origin;
  timer?: NodeJS.Timeout;
  confirmed?: boolean;
};
type Last = { turnId: string; nativeEnd: boolean; setupStop?: Origin };
const chats = new Map<string, { turn?: Turn; last?: Last }>();
const notify = (id: string) =>
  invalidate(["workspaces", "sessions", "session"], { sessionIds: [id] });

export const holdingTurn = (id: string): Readonly<Turn> | undefined => chats.get(id)?.turn;
export const lastTurn = (id: string): Readonly<Last> | undefined => chats.get(id)?.last;

// A local turn holds its chat through its end, even after an error changes the status column.
export function claimTurn(id: string, turnId: string, setup?: Setup, sentAt?: number): boolean {
  const chat = chats.get(id) ?? {};
  if (chat.turn) return false;
  chat.turn = { turnId, phase: setup ? "preparing" : "starting", setup, sentAt };
  chats.set(id, chat);
  return true;
}

export function wireTurn(id: string, turnId: string) {
  const turn = chats.get(id)?.turn;
  if (turn?.turnId !== turnId || turn.phase !== "preparing") return false;
  turn.phase = "starting";
  return true;
}

// An answer admits its starting holder, and only an unended turn.started may take a free chat.
export function admitTurn(
  id: string,
  turnId: string,
  source: "answer" | "event" | "start" = "answer",
  outputAt?: number
) {
  if (source === "start" && !holdingTurn(id)) claimTurn(id, turnId);
  const turn = chats.get(id)?.turn;
  if (turn?.turnId !== turnId || turn.phase === "preparing") return;
  turn.phase = "running";
  if (source === "answer") delete turn.setup;
  if (outputAt !== undefined) turn.lastOutputAt = outputAt;
}

// The engine can end the turn before cancel answers. Hold the credit from the ask.
export function askStop(id: string, by: Origin) {
  const turn = chats.get(id)?.turn;
  if (turn) (turn.stops ??= new Set()).add(by);
  turnNotices.queue?.(id, { type: "stop", turnId: turn?.turnId, by });
  return turn;
}

function credit(id: string, turn: Turn) {
  const first = turn.stops?.values().next().value;
  if (first !== turn.credited && persistStopCredit(id, turn.turnId, first).ok)
    turn.credited = first;
}

export function reportInterruption(
  id: string,
  turnId: string | undefined,
  gone: boolean,
  cause: "failure" | "cancelled" = "failure"
) {
  if (gone && turnId) turnNotices.withdrawCards?.(id, turnId);
  return turnNotices.queue?.(id, { type: "interrupted", turnId, gone, cause });
}

type End = "native" | "refused" | "withdrawn" | "cancelled" | "gone";
type ErrorInfo = NonNullable<TurnOutcomeWrite["error"]>;

export function releaseTurn(
  id: string,
  turnId: string | undefined,
  end?: End,
  detail?: ErrorInfo | "busy_after_end"
) {
  const chat = chats.get(id);
  const turn = chat?.turn;
  const nativeEnd = end === undefined || end === "native";
  if (turn?.turnId !== turnId) {
    if (nativeEnd && chat?.last && chat.last.turnId === turnId && !chat.last.nativeEnd)
      chat.last = { turnId, nativeEnd: true };
    return false;
  }
  const refused = end === "refused" || end === "withdrawn";
  const setupStop =
    end === "cancelled" && turn?.phase === "preparing"
      ? turn.stops?.values().next().value
      : undefined;
  if (chat && turn) {
    clearTimeout(turn.timer);
    if (!refused) {
      chat.last = { turnId: turn.turnId, nativeEnd, setupStop };
      if (end && !setupStop) credit(id, turn);
    }
    delete chat.turn;
    if (!chat.last) chats.delete(id);
  }
  if (nativeEnd) return true;
  if (detail === "busy_after_end" && chat?.last) restoreEndedStatus(id, chat.last.turnId);
  if (end === "refused" && typeof detail !== "object" && !turn?.stops?.size) {
    if (detail === "busy_after_end") {
      turnNotices.queue?.(id, { type: "available" });
      notify(id);
    }
    return true;
  }
  if (typeof detail === "object") persistSessionError(id, detail.message, detail.category);
  else if (end !== "refused") persistStopStatus(id);
  const cause = end === "cancelled" ? "cancelled" : undefined;
  const kept =
    turnId && end !== "withdrawn" ? reportInterruption(id, turnId, true, cause) : undefined;
  if (turnId && !setupStop && !refused) {
    const saved = persistTurn(id, {
      turnId,
      endedAt: Date.now(),
      stopReason: cause ?? "error",
      undeliveredSteers: kept,
    });
    notify(id);
    if (saved.ok) turnNotices.stored?.(id, turnId);
  } else notify(id);
  return true;
}

/** Free the chat before invalidation. Its next row can start after the window receives this end. */
export function endTurn({ sessionId, turnId, stopReason }: TurnEndedEvent) {
  const held = releaseTurn(sessionId, turnId, "native");
  const cancelled = stopReason === "cancelled";
  return (status: NativeEnd["status"], limit?: NativeEnd["limit"]) =>
    turnNotices.queue?.(sessionId, { type: "end", turnId, cancelled, held, status, limit });
}

export function refuseTurn(id: string, turnId: string, detail?: ErrorInfo | "busy_after_end") {
  const turn = chats.get(id)?.turn;
  if (turn?.turnId !== turnId) return false;
  if (turn.phase !== "running") return releaseTurn(id, turnId, "refused", detail);
  delete turn.setup;
  return false;
}

export function answerStop(
  id: string,
  turn: Turn | undefined,
  by: Origin,
  result: TurnCancelResult | undefined
) {
  if (turn) {
    if (!result || result.outcome === "no_active_turn") {
      turn.stops?.delete(by);
      if (turn.credited) credit(id, turn);
    } else credit(id, turn);
  }
  const live = chats.get(id)?.turn;
  if ((live && live !== turn) || (result?.outcome === "no_active_turn" && result.activeTurnId))
    return { unconfirmed: false };
  const unconfirmed = !result || result.outcome === "unconfirmed";
  if (!live) {
    if (!unconfirmed) {
      const saved = persistStopStatus(id);
      if (saved.ok && saved.value) notify(id);
    }
  } else if (result?.outcome === "no_active_turn") {
    releaseTurn(id, live.turnId, "gone");
  } else if (!live.timer || (!live.confirmed && !unconfirmed)) {
    // Confirmation starts the 15 seconds for final echoes. Later Stops cannot postpone it.
    clearTimeout(live.timer);
    live.confirmed = !unconfirmed;
    live.timer = setTimeout(() => {
      live.timer = undefined;
      const owner = holdingTurn(id);
      if (owner && owner !== live) return;
      try {
        if (live.confirmed) {
          if (owner) releaseTurn(id, live.turnId, "cancelled");
        } else {
          const warning = persistStopStatus(id, owner ? null : "error");
          if (!warning.ok || !warning.value) return;
          reportInterruption(id, live.turnId, !owner);
          notify(id);
        }
      } catch (error) {
        console.error("[Agent] Stop deadline failed:", error);
      }
    }, 15_000);
    live.timer.unref?.();
  }
  return { unconfirmed };
}

export function forgetChatTurns(id?: string) {
  // A lost handler still owes its pending Stop a warning and its steers back at the deadline.
  if (id === undefined) {
    chats.clear();
    delete turnNotices.stored;
  } else chats.delete(id);
}
