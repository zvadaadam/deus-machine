import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ActionType, EventInput } from "../bundle/schema.js";
import { ScreenStudioError } from "../errors.js";

/**
 * A Cua driver trajectory (`start_recording` with an output directory):
 *
 *   recording.mp4            the main display, system cursor drawn, display points
 *   session.json             { video: { path, duration_ms, finalized }, … }
 *   cursor.jsonl             { t_ms, x, y } samples of the system cursor
 *   turn-NNNNN/action.json   { tool, arguments, result_summary, result_error,
 *                              t_start_ms_from_session_start, t_ms_from_session_start }
 *
 * Turn times count from the start of the recording, so they are media
 * milliseconds. A click's `click_point` is in its window's screenshot, not on
 * the display, so actions carry a moment and a label but no place.
 */
interface CuaAction {
  tool?: string;
  arguments?: Record<string, unknown>;
  result_summary?: string;
  result_error?: boolean;
  t_ms_from_session_start?: number;
  t_start_ms_from_session_start?: number;
}

const TOOLS: Record<string, ActionType> = {
  click: "click",
  browser_click: "click",
  double_click: "double-click",
  right_click: "right-click",
  move_cursor: "hover",
  type_text: "type",
  type_text_chars: "type",
  set_value: "type",
  browser_type: "type",
  press_key: "key",
  hotkey: "key",
  scroll: "scroll",
  drag: "drag",
  browser_navigate: "navigate",
};

/** Tools that take text: their label counts characters and never quotes them. */
const TEXT_ARGUMENTS = ["text", "value", "chars"];

export interface CuaTrajectory {
  videoPath: string;
  /** Media milliseconds, ready for `importVideo` without a start time. */
  events: EventInput[];
  /** Turns whose tool reported an error: nothing happened on screen. */
  skipped: number;
}

export async function cuaTrajectory(dir: string): Promise<CuaTrajectory> {
  const root = resolve(dir);
  let session: { video?: { path?: string; present?: boolean } } = {};
  try {
    session = JSON.parse(await readFile(join(root, "session.json"), "utf8"));
  } catch {
    // older trajectories may lack it; the default name still applies
  }
  if (session.video?.present === false) {
    throw new ScreenStudioError("invalid_argument", "This Cua trajectory has no video", {
      hint: "Record with video enabled: start_recording({ output_dir, video: true }).",
    });
  }
  const videoPath = join(root, session.video?.path ?? "recording.mp4");

  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (err) {
    throw new ScreenStudioError(
      "invalid_argument",
      `Unreadable Cua trajectory: ${(err as Error).message}`
    );
  }
  const turns = entries.filter((name) => /^turn-\d+$/.test(name)).sort();
  const events: EventInput[] = [];
  let skipped = 0;
  for (const turn of turns) {
    let action: CuaAction;
    try {
      action = JSON.parse(await readFile(join(root, turn, "action.json"), "utf8"));
    } catch {
      continue;
    }
    const end = finite(action.t_ms_from_session_start);
    const start = finite(action.t_start_ms_from_session_start) ?? end;
    if (start === undefined || !action.tool) continue;
    if (action.result_error) {
      skipped++;
      continue;
    }
    events.push({
      kind: "action",
      type: TOOLS[action.tool] ?? "other",
      at: Math.round(start),
      ...(end !== undefined && end > start ? { endAt: Math.round(end) } : {}),
      label: labelFor(action),
      by: "cua",
    });
  }
  return { videoPath, events, skipped };
}

function labelFor(action: CuaAction): string {
  const args = action.arguments ?? {};
  for (const key of TEXT_ARGUMENTS) {
    const value = args[key];
    if (typeof value === "string") return `${action.tool} [${value.length} chars]`;
  }
  const summary = action.result_summary?.split("\n")[0]?.trim();
  return (summary || action.tool || "action").slice(0, 200);
}

const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
