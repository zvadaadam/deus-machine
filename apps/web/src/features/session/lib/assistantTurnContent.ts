import { sentText } from "@shared/agent-message";
import { toolCardName } from "@shared/mcp-servers";
import type { Part, TextPart, UnknownPart } from "@shared/protocol-types";

const QUESTION_AND_PLAN = new Set(["AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "plan"]);

/** A card stands outside work. Media and unanswered cards also stay when the turn ends. */
function card(part: Part): "keep" | "card" | undefined {
  if (part.type === "image") return "keep";
  if (part.type === "file" || part.type === "subagent") return "card";
  if (part.type !== "tool") return;
  const name = toolCardName(part);
  if (
    name === "BrowserScreenshot" ||
    (part.state.status === "completed" && part.state.content?.some((item) => item.type === "image"))
  )
    return "keep";
  if (name === "recording_stop") return part.state.status === "completed" ? "keep" : "card";
  if (part.kind === "switch_mode" || QUESTION_AND_PLAN.has(name))
    return part.state.status === "pending" || part.state.status === "in_progress" ? "keep" : "card";
  return undefined;
}

export type TurnBlock =
  | Part
  | { type: "activity"; id: string; parts: Part[] }
  | { type: "typing"; id: string };
type Parts = readonly (Part | UnknownPart)[];

/** The rows never change order. Only a running chat with agent messages condenses native words. */
export function assistantTurnContent(parts: Parts, condensed = false): TurnBlock[] {
  const rows: TurnBlock[] = [];
  let work: Part[] = [];
  function finishWork() {
    if (!work.length) return;
    const first = work.find((part) => part.type !== "text");
    if (first) rows.push({ type: "activity", id: first.id, parts: work });
    else {
      const writing = work.findLast((part) => part.type === "text" && part.state === "streaming");
      if (writing) rows.push({ type: "typing", id: writing.id });
    }
    work = [];
  }
  for (const raw of parts) {
    if ("raw" in raw) continue;
    const send = sentText(raw);
    const part = send ?? raw;
    if (part.type === "text" && !part.text.trim()) {
      if (!condensed) finishWork();
      else if (part.state === "streaming") work.push(part);
      continue;
    }
    if (part.type === "text" ? send || !condensed : card(part)) {
      finishWork();
      rows.push(part);
    } else work.push(part);
  }
  finishWork();
  return rows;
}

export function joinAnswerText(parts: readonly TextPart[]): string {
  return parts.map((part) => part.text.trim()).join("\n\n");
}

/** Closing words, or the last send/passage when the turn finished on work or a card. */
export function answerParts(parts: Parts): TextPart[] {
  const closing: TextPart[] = [];
  let lastText: TextPart | undefined;
  let lastSend: TextPart | undefined;
  for (const raw of parts) {
    if ("raw" in raw) continue;
    const send = sentText(raw);
    const part = send ?? raw;
    if (part.type === "reasoning") continue;
    if (part.type !== "text") {
      closing.length = 0;
      continue;
    }
    if (!part.text.trim()) continue;
    if (send) {
      closing.length = 0;
      lastSend = send;
    }
    closing.push(part);
    lastText = part;
  }
  if (lastSend && closing[0] === lastSend && closing.length > 1) {
    const reply = closing.slice(1);
    return joinAnswerText(reply) === lastSend.text.trim() ? [lastSend] : reply;
  }
  const fallback = lastSend ?? lastText;
  return closing.length || !fallback ? closing : [fallback];
}

export function staysAtEnd(parts: Parts): Set<string> {
  const words = answerParts(parts);
  const stays = new Set(words.map((part) => part.id));
  let lastCard: Part | undefined;
  for (const part of parts) {
    if ("raw" in part) continue;
    const kind = card(sentText(part) ?? part);
    if (kind) lastCard = part;
    if (kind === "keep") stays.add(part.id);
  }
  if (!words.length && lastCard) stays.add(lastCard.id);
  return stays;
}
