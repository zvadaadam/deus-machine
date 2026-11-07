import type {
  ActionType,
  BundleEvent,
  Manifest,
  Point,
  Rect,
  SourceKind,
} from "../bundle/schema.js";
import type { Size } from "../util/units.js";

/** An action in media time (ms from media zero) and media pixels. */
export interface TimelineAction {
  id: string;
  type: ActionType;
  startMs: number;
  endMs: number;
  point?: Point;
  rect?: Rect;
  path?: Point[];
  label?: string;
  url?: string;
  text?: string;
}

export interface Timeline {
  /** Capture window, 0..durationMs. Sparse sources may have shorter media. */
  durationMs: number;
  mediaDurationMs: number;
  /** Media pixel size; every rect and point below is in this space. */
  size: Size;
  sourceKind: SourceKind;
  actions: TimelineAction[];
  chapters: Array<{ id: string; title: string; atMs: number }>;
  holds: Array<{ id: string; atMs: number; durationMs: number; reason?: string }>;
  focus: Array<{ id: string; atMs: number; durationMs: number; rect: Rect; label?: string }>;
  notes: Array<{ id: string; atMs: number; text: string }>;
  /** Spans where the media holds a frozen frame because the source was not painted. */
  unseen: Array<{ startMs: number; endMs: number; reason: string }>;
  warnings: string[];
}

/**
 * Project bundle evidence onto the media: shift event times by the manifest
 * clock and scale coordinates from the space they were reported in. Events
 * outside recorded coverage are dropped with a warning, never clamped silently.
 */
export function buildTimeline(manifest: Manifest, events: BundleEvent[]): Timeline {
  const media = manifest.media;
  if (!media) throw new Error("Bundle has no finalized media");
  const size = { width: media.width, height: media.height };
  const origin = manifest.clock?.mediaStartEpochMs ?? 0;
  const window =
    manifest.capture.startedAt !== undefined && manifest.capture.stoppedAt !== undefined
      ? manifest.capture.stoppedAt - manifest.capture.startedAt
      : 0;
  const durationMs = Math.max(media.durationMs, window);
  const warnings: string[] = [];

  let viewport: Size = manifest.geometry?.viewport ?? size;
  // One uniform scale, centered: a viewport whose aspect differs from the
  // media (a resized tab) is letterboxed into it, never stretched.
  type Fit = { s: number; dx: number; dy: number };
  const scaleFor = (space?: Size): Fit => {
    const ref = space ?? viewport;
    const s = Math.min(size.width / ref.width, size.height / ref.height);
    return { s, dx: (size.width - ref.width * s) / 2, dy: (size.height - ref.height * s) / 2 };
  };
  const scalePoint = (p: Point, f: Fit): Point => ({ x: f.dx + p.x * f.s, y: f.dy + p.y * f.s });
  const scaleRect = (r: Rect, f: Fit): Rect => ({
    x: f.dx + r.x * f.s,
    y: f.dy + r.y * f.s,
    width: r.width * f.s,
    height: r.height * f.s,
  });

  const timeline: Timeline = {
    durationMs,
    mediaDurationMs: media.durationMs,
    size,
    sourceKind: manifest.source.kind,
    actions: [],
    chapters: [],
    holds: [],
    focus: [],
    notes: [],
    unseen: [],
    warnings,
  };

  const outside = (ms: number) => ms < -250 || ms > durationMs + 250;
  const clampMs = (ms: number) => Math.min(Math.max(ms, 0), durationMs);

  for (const event of events) {
    const atMs = event.at - origin;
    switch (event.kind) {
      case "geometry":
        viewport = event.viewport;
        break;
      case "action": {
        const endMs = (event.endAt ?? event.at) - origin;
        if (endMs < -250 || atMs > durationMs + 250) {
          warnings.push(
            `Action ${event.id} (${event.type}) is outside the recorded coverage; ignored.`
          );
          break;
        }
        const s = scaleFor(event.space);
        timeline.actions.push({
          id: event.id,
          type: event.type,
          startMs: clampMs(atMs),
          endMs: clampMs(Math.max(endMs, atMs)),
          ...(event.point ? { point: scalePoint(event.point, s) } : {}),
          ...(event.rect ? { rect: scaleRect(event.rect, s) } : {}),
          ...(event.path ? { path: event.path.map((p) => scalePoint(p, s)) } : {}),
          ...(event.label ? { label: event.label } : {}),
          ...(event.url ? { url: event.url } : {}),
          ...(event.text ? { text: event.text } : {}),
        });
        break;
      }
      case "chapter":
        if (outside(atMs)) {
          warnings.push(`Chapter "${event.title}" is outside the recorded coverage; ignored.`);
          break;
        }
        timeline.chapters.push({ id: event.id, title: event.title, atMs: clampMs(atMs) });
        break;
      case "hold":
        if (outside(atMs)) break;
        timeline.holds.push({
          id: event.id,
          atMs: clampMs(atMs),
          durationMs: event.durationMs,
          ...(event.reason ? { reason: event.reason } : {}),
        });
        break;
      case "focus":
        if (outside(atMs)) {
          warnings.push(
            `Focus "${event.label ?? event.id}" is outside the recorded coverage; ignored.`
          );
          break;
        }
        timeline.focus.push({
          id: event.id,
          atMs: clampMs(atMs),
          durationMs: event.durationMs ?? 1500,
          rect: scaleRect(event.rect, scaleFor(event.space)),
          ...(event.label ? { label: event.label } : {}),
        });
        break;
      case "note":
        if (!outside(atMs))
          timeline.notes.push({ id: event.id, atMs: clampMs(atMs), text: event.text });
        break;
      case "unseen": {
        const endMs = clampMs(event.endAt - origin);
        if (endMs > clampMs(atMs)) {
          timeline.unseen.push({ startMs: clampMs(atMs), endMs, reason: event.reason });
        }
        break;
      }
    }
  }
  timeline.actions.sort((a, b) => a.startMs - b.startMs);
  if (timeline.unseen.length) {
    const total = timeline.unseen.reduce((sum, u) => sum + u.endMs - u.startMs, 0);
    const hidden = timeline.actions.filter((a) => isUnseen(timeline, a.startMs)).length;
    warnings.push(
      `The source was not painted for ${(total / 1000).toFixed(1)} s (${timeline.unseen[0].reason}): ` +
        `that footage is a frozen frame, so edits cut it` +
        (hidden
          ? `, along with ${hidden} action${hidden === 1 ? "" : "s"} that happened there`
          : "") +
        ". Keep the recorded page visible while recording."
    );
  }
  return timeline;
}

/** Where an action happened, in media pixels. */
export function actionAnchor(action: TimelineAction): Point | null {
  if (action.point) return action.point;
  if (action.rect)
    return { x: action.rect.x + action.rect.width / 2, y: action.rect.y + action.rect.height / 2 };
  if (action.path?.length) return action.path[0];
  return null;
}

/** Whether a media time falls where the source was not painted. */
export function isUnseen(timeline: Pick<Timeline, "unseen">, ms: number): boolean {
  return timeline.unseen.some((u) => ms >= u.startMs && ms <= u.endMs);
}
