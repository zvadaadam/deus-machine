import type { Message } from "@/shared/types";
import type { Part } from "@shared/protocol-types";

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
  const name = part.toolName.startsWith("mcp__")
    ? part.toolName.split("__").slice(2).join("__")
    : part.toolName;
  if (VISIBLE_TOOLS.has(name)) return false;
  return !(
    part.state.status === "completed" && part.state.content?.some((item) => item.type === "image")
  );
}

/** A turn owns activity grouping; SDK message boundaries are not UI groups. */
export function assistantTurnContent(messages: Message[]) {
  const parts = messages
    .flatMap((message) => message.parts ?? [])
    .filter((part): part is Part => !("raw" in part));
  const activity: Part[] = [];
  const content: Part[] = [];
  let currentActivity: string | undefined;
  for (const part of parts) {
    (isActivity(part) ? activity : content).push(part);
    if (part.type === "reasoning" && part.state === "streaming") currentActivity = "Thinking";
    if (
      part.type === "tool" &&
      (part.state.status === "pending" || part.state.status === "in_progress")
    ) {
      currentActivity =
        part.title || (part.state.status === "in_progress" && part.state.title) || part.toolName;
    }
  }
  // All prose stays visible: a turn can end with a tool-only message, and
  // the wire does not label which text is the final answer.
  return { parts, activity, content, currentActivity };
}
