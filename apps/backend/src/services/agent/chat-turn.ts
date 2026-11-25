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
  | { type: "engine_idle" }
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
};
type Last = { turnId: string; nativeEnd: false | NativeEnd };
type Chat = {
  pendingStops: number;
  turn?: Turn;
  last?: Last;
  setupStop?: { turnId: string; by: Origin };
  deadline?: { kind: "settle" | "warn"; timer: NodeJS.Timeout };
};
const chats = new Map<string, Chat>();
const notify = (id: string) =>
  invalidate(["workspaces", "sessions", "session"], { sessionIds: [id] });

function prune(id: string, chat: Chat) {
  const { turn, last, setupStop, deadline, pendingStops } = chat;
  if (chats.get(id) === chat && !turn && !last && !setupStop && !deadline && !pendingStops)
    chats.delete(id);
}

function clearDeadline(chat: Chat) {
  clearTimeout(chat.deadline?.timer);
  delete chat.deadline;
}

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
  clearTimeout(old?.deadline?.timer);
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

export const firstStop = (turn?: Readonly<Turn>) => turn?.stops?.values().next().value;

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
  clearDeadline(chat);
  delete chat.turn;
  const refused = type === "refused" || type === "withdrawn";
  const by = type === "cancelled" && turn.phase === "preparing" && firstStop(turn);
  // A Stop in app setup ends in memory only. The engine's last turn still owns its late end.
  if (by) chat.setupStop = { turnId, by };
  else if (!refused) {
    delete chat.setupStop;
    chat.last = { turnId, nativeEnd: type === "end" && reason };
  }
  prune(id, chat);
  if (type === "end" || type === "snapshot") return true;
  const error = "error" in reason && reason.error;
  const prior = turn.setup?.prior;
  // An unsent claim without its own failure restores the latest the previous turn reported (its end or a fatal error), otherwise what the claim found.
  if (error) persistSessionStatus(id, "error", error.message, error.category);
  else if (prior && (refused || by)) persistSessionStatus(id, ...prior);
  else if (!refused) persistStopStatus(id);
  if (type !== "withdrawn") {
    const interrupted = !refused || !!error || !!turn.stops?.size;
    const kept = turnNotices.recover?.(id, turnId, interrupted);
    const cause = type === "cancelled" ? "cancelled" : undefined;
    if (!by && !refused) {
      const saved = persistTurn(id, {
        turnId,
        endedAt: Date.now(),
        stopReason: cause ?? "error",
        cancelledBy: firstStop(turn),
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

  // A confirmed Stop waits for its holder's final echoes, while an unconfirmed Stop still warns after handler loss.
  return (result?: TurnCancelResult | { outcome: "released" }) => {
    const absent = result?.outcome === "no_active_turn";
    if (turn) {
      // A Stop with no effect passes its credit to the next.
      if (!result || absent || result.outcome === "released") turn.stops?.delete(by);
      persistStopCredit(id, turn.turnId, firstStop(turn));
    }
    // The requested turn can end and a successor start during the RPC.
    const current = chats.get(id) === chat;
    const unconfirmed = current && (!result || result.outcome === "unconfirmed");
    if (current && !(absent && result.activeTurnId)) {
      const kind = unconfirmed ? "warn" : "settle";
      if (absent && chat.turn) {
        releaseTurn(id, chat.turn.turnId, { type: "gone" });
      } else if (!chat.turn && !unconfirmed) {
        clearDeadline(chat);
        if (persistStopStatus(id)) notify(id);
      } else if (!chat.deadline || (kind === "settle" && chat.deadline.kind === "warn")) {
        clearTimeout(chat.deadline?.timer);
        const timer = setTimeout(() => {
          delete chat.deadline;
          if (kind === "settle" && turn) return releaseTurn(id, turn.turnId, { type: "cancelled" });
          // A lost handler can leave an active row with nobody to settle it.
          if (persistStopStatus(id, chat.turn ? null : "error")) {
            reportInterruption(id, turn?.turnId, !chat.turn);
            notify(id);
          }
          prune(id, chat);
        }, 15_000).unref();
        chat.deadline = { kind, timer };
      }
      if (absent && chats.get(id) === chat) turnNotices.queue?.(id, { type: "engine_idle" });
    }
    chat.pendingStops--;
    prune(id, chat);
    return { unconfirmed };
  };
}

export function forgetChatTurns(id?: string) {
  if (id === undefined) {
    for (const chat of chats.values()) clearDeadline(chat);
    chats.clear();
    delete turnNotices.stored;
  } else {
    const chat = chats.get(id);
    if (chat) {
      if (chat.deadline?.kind === "settle") clearDeadline(chat);
      // An unconfirmed Stop still owes the lost handler's steers back at its deadline.
      delete chat.turn;
      delete chat.last;
      delete chat.setupStop;
      prune(id, chat);
    }
  }
}
