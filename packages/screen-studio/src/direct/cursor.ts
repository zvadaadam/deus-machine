/**
 * Generated pointer and touch tracks.
 *
 * These are presentation, not evidence: the capture has no pointer in it, so
 * the track is synthesized between recorded action targets — the pointer
 * travels, rests briefly, presses, and fades out while the result is read.
 * Phones get touch indicators instead of a pointer.
 */
import type { Point } from "../bundle/schema.js";
import { actionAnchor, type TimelineAction } from "../edit/timeline.js";
import { clamp, type Size } from "../util/units.js";
import type { CursorTokens } from "./presets.js";

export interface CursorFrame {
  /** Media pixels. */
  x: number;
  y: number;
  opacity: number;
  /** Press feedback: 1 at rest, smaller while pressed. */
  scale: number;
  /** Ms since a click, while its ripple is visible. */
  rippleAgeMs: number | null;
}

export interface TouchFrame {
  x: number;
  y: number;
  opacity: number;
  pressed: number;
}

const CLICKS = new Set(["click", "double-click", "right-click", "tap", "long-press"]);

/** Evaluate a CSS-style cubic-bezier easing curve. */
export function bezier(progress: number, curve: readonly [number, number, number, number]): number {
  const p = clamp(progress, 0, 1);
  if (p === 0 || p === 1) return p;
  const [x1, y1, x2, y2] = curve;
  const at = (t: number, a: number, b: number) =>
    3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t * t * b + t ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid, x1, x2) < p) lo = mid;
    else hi = mid;
  }
  return at((lo + hi) / 2, y1, y2);
}

interface Stop {
  id: string;
  type: string;
  atMs: number;
  endMs: number;
  point: Point;
  path?: Point[];
}

function stopsOf(actions: TimelineAction[]): Stop[] {
  const stops: Stop[] = [];
  for (const action of actions) {
    const point = actionAnchor(action);
    if (!point) continue;
    stops.push({
      id: action.id,
      type: action.type,
      atMs: action.startMs,
      endMs: action.endMs,
      point,
      path: action.path,
    });
  }
  return stops.sort((a, b) => a.atMs - b.atMs);
}

/** Where a stop leaves the pointer: the end of a drag, else its anchor. */
function restingPoint(stop: Stop): Point {
  return stop.path?.length ? stop.path[stop.path.length - 1] : stop.point;
}

function along(path: Point[], progress: number): Point {
  if (path.length === 1) return path[0];
  const scaled = clamp(progress, 0, 1) * (path.length - 1);
  const i = Math.min(path.length - 2, Math.floor(scaled));
  const f = scaled - i;
  return {
    x: path[i].x + (path[i + 1].x - path[i].x) * f,
    y: path[i].y + (path[i + 1].y - path[i].y) * f,
  };
}

export function pointerTrack(
  actions: TimelineAction[],
  frames: number,
  fps: number,
  size: Size,
  tokens: CursorTokens
): Array<CursorFrame | null> {
  const stops = stopsOf(actions);
  if (stops.length === 0) return new Array(frames).fill(null);
  const settle = tokens.pressMs + tokens.releaseMs;

  // Travel windows: arrive `dwell` before each action, leave after the
  // previous press settles, shrink travel when actions are close.
  const legs = stops.map((stop, i) => {
    const prev = stops[i - 1];
    const earliest = prev ? Math.max(prev.endMs, prev.atMs + settle) : -Infinity;
    // Actions closer than the dwell: stay on the earlier target until it is
    // pressed, and arrive at the next one only as it happens.
    const arrive = Math.max(stop.atMs - tokens.dwellMs, Math.min(earliest, stop.atMs));
    const travel = Math.min(tokens.travelMs, Math.max(0, arrive - earliest));
    const from = prev
      ? restingPoint(prev)
      : {
          x: clamp(stop.point.x + size.width * 0.07, 0, size.width),
          y: clamp(stop.point.y + size.height * 0.1, 0, size.height),
        };
    return { stop, from, depart: arrive - travel, arrive, travel };
  });

  const track: Array<CursorFrame | null> = [];
  let leg = 0;
  for (let f = 0; f < frames; f++) {
    const t = (f * 1000) / fps;
    while (leg + 1 < legs.length && t >= legs[leg + 1].depart - tokens.fadeMs) leg++;
    const current = legs[leg];
    const previous = legs[leg - 1];
    let position: Point;
    if (t < current.depart) {
      position = previous ? restingPoint(previous.stop) : current.from;
    } else if (t < current.arrive && current.travel >= tokens.minTravelMs) {
      const p = bezier((t - current.depart) / current.travel, tokens.travelCurve);
      position = arc(current.from, current.stop.point, p, tokens.arc);
    } else if (t < current.arrive) {
      position = previous ? restingPoint(previous.stop) : current.from;
    } else if (current.stop.path && t < current.stop.endMs) {
      const span = Math.max(1, current.stop.endMs - current.stop.atMs);
      position = along(current.stop.path, bezier((t - current.stop.atMs) / span, [0.4, 0, 0.6, 1]));
    } else {
      position = restingPoint(current.stop);
    }

    // Each leg is visible from just before it departs until a while after its
    // action completes; overlapping envelopes keep the pointer up between
    // close actions.
    const visibility = (l: (typeof legs)[number]) => {
      const done = Math.max(l.stop.endMs, l.stop.atMs);
      const fadeIn = bezier((t - (l.depart - tokens.fadeMs)) / tokens.fadeMs, tokens.feedbackCurve);
      const fadeOut =
        1 - bezier((t - (done + tokens.hideAfterMs)) / tokens.fadeMs, tokens.feedbackCurve);
      return Math.min(fadeIn, fadeOut);
    };
    const opacity = Math.max(visibility(current), previous ? visibility(previous) : 0);

    // Press feedback for the action whose moment has passed most recently.
    const pressed = t >= current.stop.atMs ? current.stop : previous?.stop;
    let scale = 1;
    let rippleAgeMs: number | null = null;
    if (pressed && CLICKS.has(pressed.type)) {
      const age = t - pressed.atMs;
      if (age >= 0 && age < tokens.pressMs)
        scale = 1 - 0.12 * bezier(age / tokens.pressMs, tokens.feedbackCurve);
      else if (age >= tokens.pressMs && age < settle) {
        scale =
          0.88 + 0.12 * bezier((age - tokens.pressMs) / tokens.releaseMs, tokens.feedbackCurve);
      }
      if (age >= 0 && age < tokens.rippleMs) rippleAgeMs = age;
    }
    track.push(
      opacity > 0.01
        ? { x: position.x, y: position.y, opacity: clamp(opacity, 0, 1), scale, rippleAgeMs }
        : null
    );
  }
  return track;
}

/** A gently bowed path reads as a hand moving, a straight line as a robot. */
function arc(from: Point, to: Point, p: number, bow: number): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const bend = Math.sin(Math.PI * p) * bow;
  return { x: from.x + dx * p - dy * bend, y: from.y + dy * p + dx * bend };
}

export function touchTrack(
  actions: TimelineAction[],
  frames: number,
  fps: number,
  tokens: CursorTokens
): Array<TouchFrame | null> {
  const stops = stopsOf(actions);
  const appear = 70;
  const hold = tokens.pressMs + 120;
  const track: Array<TouchFrame | null> = [];
  for (let f = 0; f < frames; f++) {
    const t = (f * 1000) / fps;
    let frame: TouchFrame | null = null;
    for (const stop of stops) {
      const end = Math.max(stop.endMs, stop.atMs + (stop.path ? 300 : 0));
      if (t < stop.atMs - appear || t > end + hold + tokens.fadeMs) continue;
      const moving = stop.path && t >= stop.atMs && t <= end;
      const point = moving
        ? along(stop.path!, (t - stop.atMs) / Math.max(1, end - stop.atMs))
        : t > end
          ? restingPoint(stop)
          : stop.point;
      const fadeIn = bezier((t - (stop.atMs - appear)) / appear, tokens.feedbackCurve);
      const fadeOut = 1 - bezier((t - (end + hold)) / tokens.fadeMs, tokens.feedbackCurve);
      const pressed = t >= stop.atMs && t <= end + tokens.pressMs ? 1 : 0;
      frame = { x: point.x, y: point.y, opacity: clamp(Math.min(fadeIn, fadeOut), 0, 1), pressed };
    }
    track.push(frame && frame.opacity > 0.01 ? frame : null);
  }
  return track;
}
