import type { Origin } from "@zvada/agent-server/protocol";

type Setup = {
  controller: AbortController;
  done: Promise<void>;
  stoppedBy?: Origin;
  firstTask?: boolean;
};
type Turn = {
  turnId: string;
  phase: "preparing" | "starting" | "running";
  sentAt?: number;
  lastOutputAt?: number;
  setup?: Setup;
};
type Last = { turnId: string; nativeEnd: boolean; setupStop?: Origin };
const chats = new Map<string, { turn?: Turn; last?: Last }>();

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

export function stopStartingTurn(id: string, by: Origin) {
  const turn = chats.get(id)?.turn;
  if (turn?.setup) turn.setup.stoppedBy ??= by;
  return turn;
}

export function releaseTurn(
  id: string,
  turnId: string,
  end: "native" | "local" | "refused",
  by?: Origin
) {
  const chat = chats.get(id);
  if (chat?.turn?.turnId !== turnId) {
    if (end === "native" && chat?.last?.turnId === turnId && !chat.last.nativeEnd)
      chat.last = { turnId, nativeEnd: true };
    return false;
  }
  if (end !== "refused") chat.last = { turnId, nativeEnd: end === "native", setupStop: by };
  delete chat.turn;
  if (!chat.last) chats.delete(id);
  return true;
}

export function refuseTurn(id: string, turnId: string) {
  const turn = chats.get(id)?.turn;
  if (turn?.turnId !== turnId) return false;
  if (turn.phase !== "running") return releaseTurn(id, turnId, "refused");
  delete turn.setup;
  return false;
}

export function forgetChatTurns(id?: string) {
  if (id === undefined) chats.clear();
  else chats.delete(id);
}
