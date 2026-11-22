import { toolCardName } from "@shared/mcp-servers";
import type { Part, UnknownPart } from "@shared/protocol-types";

// These renderers expose an answer/action or media that must stay visible.
const VISIBLE_TOOLS = new Set([
  "AskUserQuestion",
  "ExitPlanMode",
  "BrowserScreenshot",
  "recording_stop",
]);

function isActivity(part: Part): boolean {
  if (part.type === "reasoning") return true;
  if (part.type !== "tool") return false;
  if (part.state.status === "failed" || part.kind === "switch_mode") return false;
  if (VISIBLE_TOOLS.has(toolCardName(part))) return false;
  return !(
    part.state.status === "completed" && part.state.content?.some((item) => item.type === "image")
  );
}

type TurnBlock = Part | { type: "activity"; id: string; parts: Part[] };

/** Both the live fold and the saved page supply parts in transcript order. */
export function assistantTurnContent(parts: readonly (Part | UnknownPart)[]): TurnBlock[] {
  const blocks: TurnBlock[] = [];
  for (const part of parts) {
    if ("raw" in part) continue;
    if (isActivity(part)) {
      const previous = blocks.at(-1);
      if (previous?.type === "activity") previous.parts.push(part);
      else blocks.push({ type: "activity", id: part.id, parts: [part] });
    } else {
      blocks.push(part);
    }
  }
  return blocks;
}
