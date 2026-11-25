// Which turn holds a chat, and how far it got. The status column can show working for two
// consecutive turns, or error before the turn ends. Release is the only exit.
import type { Origin, TurnCancelResult } from "@zvada/agent-server/protocol";
import { invalidate } from "../query-engine";
import {
  persistSessionStatus,
  persistStopCredit,
  persistStopStatus,
  persistTurn,
  terminalStatus,
  type SessionProjection,
  type TurnOutcomeWrite,
} from "./persistence";

export type NativeEnd = {
  type: "end";
  turnId: string;
  cancelled: boolean;
  held: boolean;
  outcome?: TurnOutcomeWrite;
  limit?: { resetsAt?: number };
};
export type TurnNotice =
  | NativeEnd
  | { type: "stop"; turnId?: string; by: Origin }
  | { type: "interrupted"; turnId?: string; gone: boolean; cause: "failure" | "cancelled" };
export const turnNotices: {
  queue?: (id: string, notice: TurnNotice) => void;
  recover?: (id: string, turnId: string, returnHead?: boolean) => string[] | undefined;
  withdrawCards?: (id: string, turnId: string) => void;
  stored?: (id: string, turnId: string) => void;
} = {};
type Setup = {
  controller: AbortController;
  done: Promise<void>;
  prior?: SessionProjection;
};
type Turn = {
  turnId: string;
  phase: "preparing" | "starting" | "running";
  sentAt?: number;
  lastOutputAt?: number;
  setup?: Setup;
  stops?: Set<Origin>;
  credited?: Origin;
};
type Last = { turnId: string; nativeEnd: false | NativeEnd };
type Chat = {
  pendingStops: number;
  turn?: Turn;
  last?: Last;
  setupStop?: { turnId: string; by: Origin };
  timer?: NodeJS.Timeout;
  confirmed?: boolean;
};
const chats = new Map<string, Chat>();
const notify = (id: string) =>
  invalidate(["workspaces", "sessions", "session"], { sessionIds: [id] });

export const holdingTurn = (id: string): Readonly<Turn> | undefined => chats.get(id)?.turn;
export const lastTurn = (id: string): Readonly<Last> | undefined => chats.get(id)?.last;

export const setupStop = (id: string) => chats.get(id)?.setupStop;
export function competingEnd(id: string, winner?: string) {
  const end = lastTurn(id)?.nativeEnd;
  return end && end.turnId === winner ? end : undefined;
}

export function claimTurn(id: string, turnId: string, setup?: Setup, sentAt?: number): boolean {
  const old = chats.get(id);
  if (old?.turn) return false;
  clearTimeout(old?.timer);
  const chat: Chat = { pendingStops: 0, last: old?.last, setupStop: old?.setupStop };
  chat.turn = { turnId, phase: setup ? "preparing" : "starting", setup, sentAt };
  chats.set(id, chat);
  return true;
}

export function wireTurn(id: string, turnId: string) {
  const turn = chats.get(id)?.turn;
  if (turn?.turnId === turnId && turn.phase === "preparing") turn.phase = "starting";
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
  turnNotices.queue?.(id, { type: "interrupted", turnId, gone, cause });
}

type ErrorInfo = NonNullable<TurnOutcomeWrite["error"]>;
type Release =
  | NativeEnd
  | { type: "snapshot" | "withdrawn" }
  | { type: "cancelled" | "gone" | "refused"; error?: ErrorInfo };

export function releaseTurn(id: string, turnId: string, reason: Release) {
  const chat = chats.get(id);
  const turn = chat?.turn;
  if (!chat) return false;
  const { type } = reason;
  if (turn?.turnId !== turnId) {
    // A late native end corrects a local end. A successor keeps working until it gives up.
    if (type === "end" && chat.last?.turnId === turnId && !chat.last.nativeEnd) {
      chat.last.nativeEnd = reason;
      const setup = turn?.setup;
      if (setup && reason.outcome) setup.prior = terminalStatus(reason.outcome, setup.prior);
    }
    return false;
  }
  // A lost answer cannot end a turn the engine has already shown running.
  if (type === "refused" && turn.phase === "running") {
    delete turn.setup;
    return false;
  }
  clearTimeout(chat.timer);
  delete chat.timer;
  delete chat.turn;
  const refused = type === "refused" || type === "withdrawn";
  const by =
    type === "cancelled" && turn.phase === "preparing" && turn.stops?.values().next().value;
  // A Stop in app setup ends in memory only. The engine's last turn still owns its late end.
  if (by) chat.setupStop = { turnId, by };
  else if (!refused) {
    delete chat.setupStop;
    chat.last = { turnId, nativeEnd: type === "end" && reason };
    if (type !== "snapshot") credit(id, turn);
  }
  if (!chat.last && !chat.setupStop && !chat.pendingStops) chats.delete(id);
  if (type === "end" || type === "snapshot") return true;
  const error = "error" in reason && reason.error;
  const prior = turn.setup?.prior;
  // An unsent claim without a failure of its own leaves the chat as if it had never been made.
  if (error) persistSessionStatus(id, "error", error.message, error.category);
  else if (prior && (refused || by)) persistSessionStatus(id, ...prior);
  else if (!refused) persistStopStatus(id);
  if (type !== "withdrawn") {
    const interrupted = !refused || !!error || !!turn.stops?.size;
    const kept = turnNotices.recover?.(id, turnId, interrupted);
    const cause = type === "cancelled" ? "cancelled" : undefined;
    if (!by && (!refused || kept?.length)) {
      const saved = persistTurn(id, {
        turnId,
        endedAt: Date.now(),
        stopReason: cause ?? "error",
        undeliveredSteers: kept,
      });
      if (saved.ok) turnNotices.stored?.(id, turnId);
    }
    if (interrupted || kept?.length) reportInterruption(id, turnId, true, cause);
  }
  notify(id);
  return true;
}

export function refuseTurn(id: string, turnId: string, error?: ErrorInfo) {
  return releaseTurn(id, turnId, { type: "refused", error });
}

// The engine can end the turn before cancel answers. Hold the credit from the ask.
export function askStop(id: string, origin: Origin) {
  // Two Stops from the same caller still have separate answers.
  const by = { ...origin };
  const chat = chats.get(id) ?? { pendingStops: 0 };
  chat.pendingStops++;
  chats.set(id, chat);
  const turn = chat.turn;
  if (turn) (turn.stops ??= new Set()).add(by);
  turnNotices.queue?.(id, { type: "stop", turnId: turn?.turnId, by });

  /** A confirmed cancel holds the chat for final echoes, at most 15 s. An unconfirmed cancel only warns. */
  return (result?: TurnCancelResult) => {
    chat.pendingStops--;
    if (turn) {
      // A Stop with no effect passes its credit to the next.
      if (!result || result.outcome === "no_active_turn") turn.stops?.delete(by);
      credit(id, turn);
    }
    // The requested turn can end and a successor start during the RPC.
    if (chats.get(id) !== chat || (result?.outcome === "no_active_turn" && result.activeTurnId))
      return { unconfirmed: false };
    const unconfirmed = !result || result.outcome === "unconfirmed";
    if (result?.outcome === "no_active_turn" && chat.turn) {
      releaseTurn(id, chat.turn.turnId, { type: "gone" });
    } else if (!chat.turn && !unconfirmed) {
      const saved = persistStopStatus(id);
      if (saved.ok && saved.value) notify(id);
    } else if (!chat.timer || (!chat.confirmed && !unconfirmed)) {
      clearTimeout(chat.timer);
      chat.confirmed = !unconfirmed;
      chat.timer = setTimeout(() => {
        delete chat.timer;
        if (!unconfirmed) {
          if (chat.turn) releaseTurn(id, chat.turn.turnId, { type: "cancelled" });
          return;
        }
        // A lost handler can leave an active row with nobody to settle it.
        const saved = persistStopStatus(id, chat.turn ? null : "error");
        if (saved.ok && saved.value) {
          reportInterruption(id, turn?.turnId, !chat.turn);
          notify(id);
        }
      }, 15_000);
      chat.timer.unref?.();
    }
    return { unconfirmed };
  };
}

export function forgetChatTurns(id?: string) {
  if (id === undefined) {
    for (const chat of chats.values()) clearTimeout(chat.timer);
    chats.clear();
    delete turnNotices.stored;
  } else {
    const chat = chats.get(id);
    if (chat && (chat.timer || chat.pendingStops)) {
      // An unconfirmed Stop still owes the lost handler's steers back at its deadline.
      delete chat.turn;
      delete chat.last;
      delete chat.setupStop;
    } else chats.delete(id);
  }
}
