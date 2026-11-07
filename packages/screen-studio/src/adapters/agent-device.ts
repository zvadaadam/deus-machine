import { readFile } from "node:fs/promises";
import type { ActionType, EventInput } from "../bundle/schema.js";
import { ScreenStudioError } from "../errors.js";

/**
 * agent-device gesture telemetry (`record` exports it beside the video):
 * `{ version, events: [{ kind, tMs, x, y, referenceWidth, referenceHeight, … }] }`.
 * `tMs` is milliseconds from the start of that video; coordinates are iOS
 * points in the reference size. Its video already shows touch indicators.
 */
interface TelemetryEvent {
  kind?: string;
  tMs?: number;
  x?: number;
  y?: number;
  referenceWidth?: number;
  referenceHeight?: number;
  durationMs?: number;
  [key: string]: unknown;
}

const KINDS: Record<string, ActionType> = {
  tap: "tap",
  doubletap: "double-click",
  "double-tap": "double-click",
  longpress: "long-press",
  "long-press": "long-press",
  swipe: "swipe",
  scroll: "scroll",
  drag: "drag",
  pinch: "pinch",
  type: "type",
  fill: "type",
  press: "key",
  key: "key",
};

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Events in media milliseconds, ready for `importVideo` without a start time. */
export async function agentDeviceEvents(path: string): Promise<EventInput[]> {
  let parsed: { events?: TelemetryEvent[] };
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    throw new ScreenStudioError(
      "invalid_argument",
      `Unreadable agent-device telemetry: ${(err as Error).message}`
    );
  }
  if (!Array.isArray(parsed.events)) {
    throw new ScreenStudioError("invalid_argument", "agent-device telemetry has no events array");
  }
  return parsed.events.flatMap((e): EventInput[] => {
    const at = num(e.tMs);
    if (at === undefined) return [];
    const type = KINDS[String(e.kind ?? "").toLowerCase()] ?? "other";
    const x = num(e.x);
    const y = num(e.y);
    const toX = num(e.toX) ?? num(e.x2) ?? num(e.endX);
    const toY = num(e.toY) ?? num(e.y2) ?? num(e.endY);
    const width = num(e.referenceWidth);
    const height = num(e.referenceHeight);
    const duration = num(e.durationMs);
    return [
      {
        kind: "action",
        type,
        at: Math.round(at),
        ...(duration !== undefined ? { endAt: Math.round(at + duration) } : {}),
        ...(x !== undefined && y !== undefined ? { point: { x, y } } : {}),
        ...(x !== undefined && y !== undefined && toX !== undefined && toY !== undefined
          ? {
              path: [
                { x, y },
                { x: toX, y: toY },
              ],
            }
          : {}),
        ...(width && height ? { space: { width, height } } : {}),
        label: String(e.kind ?? "gesture"),
        by: "agent-device",
      },
    ];
  });
}
