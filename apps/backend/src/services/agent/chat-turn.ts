// Which turn holds a chat, and how far it got. The status column can show working for two
// consecutive turns, or error before the turn ends. Release is the only exit.
import type { Origin, TurnCancelResult } from "@zvada/agent-server/protocol";
import { match } from "ts-pattern";
import type { GatewayFormat } from "@shared/gateways";
import type { AgentHarness } from "@shared/enums";
import type { ThinkingLevel } from "@shared/protocol";
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
  by?: Origin;
  outcome?: TurnOutcomeWrite;
  limit?: { resetsAt?: number };
};
export type TurnNotice =
  | NativeEnd
  | { type: "engine_idle" }
  | { type: "stop"; turnId?: string; by: Origin }
  | {
      type: "interrupted";
      turnId?: string;
      gone: boolean;
      cause: "failure" | "cancelled";
      by?: Origin;
    };
/** What a release says about its turn, for a watcher. */
export interface Released {
  /** False when the turn never ran (withdrawn, or refused before admission with no stop). */
  ended: boolean;
  /** Who stopped it: only when the release is that Stop's cancel, not a finish that beat it. */
  stoppedBy?: Origin;
  /** Its usage limit, as the end reported it. */
  limit?: { resetsAt?: number };
  /** It failed; `error` says why when the release itself knows (a refusal, a lost turn, an incomplete transcript). */
  failed?: true;
  error?: string;
  /** The engine ended it normally. */
  finished?: true;
}
/** Someone outside the agent service who follows chats' turns (a coordinator's wake). */
export interface TurnWatch {
  /** A turn let go of its chat. */
  released(sessionId: string, turnId: string, release: Released): void;
  /** A chat's agent now waits on a question or a plan approval (`requestId`). */
  asked(sessionId: string, turnId: string, requestId: string): void;
}
interface TurnNotices {
  queue: (id: string, notice: TurnNotice) => void;
  recover: (id: string, turnId: string, returnHead?: boolean) => string[] | undefined;
  withdrawCards: (id: string, turnId: string) => void;
  stored: (id: string, turnId: string) => void;
  watch?: TurnWatch;
}
let connected: TurnNotices | undefined;
export function connectTurnNotices(notices: TurnNotices) {
  connected = notices;
}
/** Tell the watch, if any. Its failure is logged and never stops a release or a prompt. */
export function tellWatch(tell: (watch: TurnWatch) => void) {
  const watch = connected?.watch;
  if (!watch) return;
  try {
    tell(watch);
  } catch (error) {
    console.error("[TurnWatch] A watcher failed:", error);
  }
}
export function turnNotices() {
  if (!connected) throw new Error("Turn notices have not been connected.");
  return connected;
}

type Setup = {
  controller: AbortController;
  done: Promise<void>;
  prior?: SessionProjection;
};
export interface GatewayAttribution {
  binding: { readonly ref: string; readonly revision: string; readonly format: GatewayFormat };
  execution: {
    readonly harness: AgentHarness;
    readonly model: string;
    via?: string;
    modelLabel?: string;
  };
}

export interface GatewayTurn extends GatewayAttribution {
  delivery?: { apiKey: string; baseUrl: string };
  thinkingLevel?: ThinkingLevel;
}

export function gatewayExecution(gateway: GatewayAttribution) {
  return { ...gateway.execution, gatewayRef: gateway.binding.ref };
}

type Turn = {
  turnId: string;
  phase: "preparing" | "starting" | "running";
  sentAt?: number;
  requested?: { model: string; thinkingLevel?: string; permissionMode?: string };
  lastOutputAt?: number;
  setup?: Setup;
  stops?: Set<Origin>;
  gateway?: GatewayTurn;
};
type Last = { turnId: string; nativeEnd: false | NativeEnd; gateway?: GatewayAttribution };
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

export function claimTurn(
  id: string,
  turnId: string,
  setup?: Setup,
  sentAt?: number,
  gateway?: GatewayTurn,
  requested?: Turn["requested"]
): boolean {
  const old = chats.get(id);
  if (old?.turn) return false;
  clearTimeout(old?.deadline?.timer);
  const chat: Chat = { pendingStops: 0, last: old?.last, setupStop: old?.setupStop };
  chat.turn = {
    turnId,
    phase: setup ? "preparing" : "starting",
    setup,
    sentAt,
    gateway,
    requested,
  };
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
  cause: "failure" | "cancelled" = "failure",
  by?: Origin
) {
  if (gone && turnId) turnNotices().withdrawCards(id, turnId);
  turnNotices().queue(id, { type: "interrupted", turnId, gone, cause, by });
}

type ErrorInfo = NonNullable<TurnOutcomeWrite["error"]>;
type Release =
  | NativeEnd
  | { type: "snapshot" | "withdrawn" }
  | { type: "cancelled" | "gone" | "refused"; error?: ErrorInfo };

export function releaseTurn(id: string, turnId: string, reason: Release) {
  const chat = chats.get(id);
  const turn = chat?.turn;
  if (!chat || turn?.turnId !== turnId) {
    // A late native end corrects a local end. A successor keeps working until it gives up.
    if (reason.type === "end" && chat?.last?.turnId === turnId && !chat.last.nativeEnd) {
      chat.last.nativeEnd = reason;
      const setup = turn?.setup;
      if (setup && reason.outcome) setup.prior = terminalStatus(reason.outcome, setup.prior);
    }
    return false;
  }
  // A lost answer cannot end a turn the engine has already shown running.
  if (reason.type === "refused" && turn.phase === "running") {
    delete turn.setup;
    return false;
  }
  clearDeadline(chat);
  delete chat.turn;
  const by = firstStop(turn);
  const error = "error" in reason ? reason.error : undefined;
  const prior = turn.setup?.prior;
  const remember = () => {
    delete chat.setupStop;
    const gateway = turn.gateway && {
      binding: turn.gateway.binding,
      execution: turn.gateway.execution,
    };
    chat.last = { turnId, nativeEnd: reason.type === "end" && reason, gateway };
  };
  const writeStatus = (status: SessionProjection | "stopped" | undefined) => {
    if (error) persistSessionStatus(id, "error", error.message, error.category);
    else if (status === "stopped") persistStopStatus(id);
    else if (status) persistSessionStatus(id, ...status);
  };
  const endLocally = (stopReason: "cancelled" | "error") => {
    remember();
    writeStatus("stopped");
    const kept = turnNotices().recover(id, turnId, true);
    const saved = persistTurn(id, {
      turnId,
      endedAt: Date.now(),
      stopReason,
      cancelledBy: by,
      undeliveredSteers: kept,
      ...(turn.gateway && {
        execution: gatewayExecution(turn.gateway),
        gatewayRevision: turn.gateway.binding.revision,
      }),
    });
    if (saved.ok) turnNotices().stored(id, turnId);
    reportInterruption(id, turnId, true, stopReason === "cancelled" ? "cancelled" : "failure", by);
    notify(id);
  };

  match(reason.type)
    .with("end", remember)
    .with("snapshot", remember)
    .with("withdrawn", () => {
      writeStatus(prior);
      notify(id);
    })
    .with("refused", () => {
      // An unsent claim without its own failure restores the latest the previous turn reported
      // (its end or a fatal error), otherwise what the claim found.
      writeStatus(prior);
      const interrupted = !!error || !!by;
      const kept = turnNotices().recover(id, turnId, interrupted);
      if (interrupted || kept?.length) reportInterruption(id, turnId, true);
      notify(id);
    })
    .with("cancelled", () => {
      if (turn.phase !== "preparing" || !by) return endLocally("cancelled");
      // A Stop in app setup leaves the engine's last turn free to report its late end.
      chat.setupStop = { turnId, by };
      writeStatus(prior ?? "stopped");
      turnNotices().recover(id, turnId, true);
      reportInterruption(id, turnId, true, "cancelled", by);
      notify(id);
    })
    .with("gone", () => endLocally("error"))
    .exhaustive();
  prune(id, chat);
  // A withdrawn claim, or one refused before admission with no stop of its own, never ran.
  const ended = reason.type !== "withdrawn" && (reason.type !== "refused" || !!error || !!by);
  const cancelled =
    reason.type === "cancelled" ||
    (reason.type === "end" && reason.cancelled) ||
    (reason.type === "refused" && !error);
  const failed =
    reason.type === "end" ? reason.outcome?.status === "error" : !!error || reason.type === "gone";
  const failure = reason.type === "end" ? reason.outcome?.error : error;
  const finished = reason.type === "end" && !reason.cancelled && reason.outcome?.status === "idle";
  tellWatch((watch) =>
    watch.released(id, turnId, {
      ended,
      ...(cancelled && by && { stoppedBy: by }),
      ...(reason.type === "end" && reason.limit && { limit: reason.limit }),
      ...(failed && { failed: true, ...(failure && { error: failure.message }) }),
      ...(finished && { finished: true }),
    })
  );
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
  turnNotices().queue(id, { type: "stop", turnId: turn?.turnId, by });

  // A confirmed Stop waits for its holder's final echoes, while an unconfirmed Stop still warns after handler loss.
  const deadline = (kind: "settle" | "warn") => {
    if (chat.deadline?.kind === "settle" || chat.deadline?.kind === kind) return;
    clearDeadline(chat);
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
  };

  return (result?: TurnCancelResult | { outcome: "released" }) => {
    if (turn) {
      // Only a Stop the engine took can keep the credit.
      if (result?.outcome !== "cancelled" && result?.outcome !== "unconfirmed")
        turn.stops?.delete(by);
      persistStopCredit(id, turn.turnId, firstStop(turn));
    }
    const settle = () => {
      if (chat.turn) return deadline("settle");
      clearDeadline(chat);
      if (persistStopStatus(id)) notify(id);
    };
    // The requested turn can end and a successor start during the RPC.
    const unconfirmed =
      chats.get(id) === chat &&
      match(result)
        .with({ outcome: "cancelled" }, { outcome: "released" }, settle)
        .with({ outcome: "unconfirmed" }, undefined, () => {
          deadline("warn");
          return true;
        })
        .with({ outcome: "no_active_turn" }, ({ activeTurnId }) => {
          if (activeTurnId) return;
          if (chat.turn) releaseTurn(id, chat.turn.turnId, { type: "gone" });
          else settle();
        })
        .exhaustive();
    // A refused retry can replace the chat record while this Stop is waiting for its answer.
    if (result?.outcome === "no_active_turn" && !result.activeTurnId && !holdingTurn(id))
      turnNotices().queue(id, { type: "engine_idle" });
    chat.pendingStops--;
    prune(id, chat);
    return { unconfirmed: unconfirmed === true };
  };
}

export function forgetChatTurns(id?: string) {
  if (id === undefined) {
    for (const chat of chats.values()) clearDeadline(chat);
    chats.clear();
    connected = undefined;
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
