/**
 * Shot planning: where the camera looks, and why.
 *
 * Agents should not choose camera coordinates or spring constants. Actions
 * that happen close together in time and on screen share one shot that fits
 * all of their targets; page-level actions (navigate, scroll) go wide; a
 * focus hint ("show the confirmation") overrides action framing while it
 * lasts. The plan is plain data with a reason per shot, so an agent or editor
 * can review it before anything is rendered.
 */
import type { Rect } from "../bundle/schema.js";
import type { ActionResult } from "../edit/results.js";
import { actionAnchor, type TimelineAction } from "../edit/timeline.js";
import { clamp, type Size } from "../util/units.js";
import type { CameraTokens } from "./presets.js";

export interface Camera {
  /** View center in media pixels. */
  x: number;
  y: number;
  zoom: number;
}

export interface Shot {
  /** Output time the camera starts moving toward this shot. */
  atMs: number;
  camera: Camera;
  target: Rect | null;
  reason: string;
  events: string[];
}

export interface ShotPlan {
  shots: Shot[];
  warnings: string[];
}

/** An action or focus hint already mapped to output time. */
export interface DirectedFocus {
  id: string;
  atMs: number;
  durationMs: number;
  rect: Rect;
  label?: string;
}

const WIDE_TYPES = new Set(["navigate", "scroll", "key", "pinch"]);

export function overview(size: Size): Camera {
  return { x: size.width / 2, y: size.height / 2, zoom: 1 };
}

/** Frame a rect with padding, capped zoom, and the view kept inside the media. */
export function fitCamera(
  rect: Rect,
  size: Size,
  tokens: Pick<CameraTokens, "maxZoom" | "padding">
): Camera {
  const pad = tokens.padding * size.height;
  const zoom = clamp(
    Math.min(size.width / (rect.width + pad * 2), size.height / (rect.height + pad * 2)),
    1,
    tokens.maxZoom
  );
  const viewW = size.width / zoom;
  const viewH = size.height / zoom;
  return {
    x: clamp(rect.x + rect.width / 2, viewW / 2, size.width - viewW / 2),
    y: clamp(rect.y + rect.height / 2, viewH / 2, size.height - viewH / 2),
    zoom,
  };
}

function union(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return {
    x,
    y,
    width: Math.max(...rects.map((r) => r.x + r.width)) - x,
    height: Math.max(...rects.map((r) => r.y + r.height)) - y,
  };
}

/** The region an action is about. Points get a box a little larger than a control. */
function targetOf(action: TimelineAction, size: Size): Rect | null {
  if (action.rect && action.rect.width > 2 && action.rect.height > 2) return action.rect;
  if (action.path?.length) {
    const xs = action.path.map((p) => p.x);
    const ys = action.path.map((p) => p.y);
    return {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys),
    };
  }
  const anchor = actionAnchor(action);
  if (!anchor) return null;
  const w = size.width * 0.12;
  const h = size.height * 0.08;
  return { x: anchor.x - w / 2, y: anchor.y - h / 2, width: w, height: h };
}

interface Cluster {
  wide: boolean;
  rects: Rect[];
  startMs: number;
  endMs: number;
  ids: string[];
  types: string[];
}

export function planShots(input: {
  actions: TimelineAction[];
  focus: DirectedFocus[];
  /** Results seen in the picture (output time); framed unless a focus hint covers them. */
  results?: Array<Pick<ActionResult, "atMs" | "region" | "share" | "actionId" | "delayMs">>;
  size: Size;
  durationMs: number;
  tokens: CameraTokens;
}): ShotPlan {
  const { size, tokens } = input;
  const wide = overview(size);
  const warnings: string[] = [];
  if (!tokens.enabled) {
    return {
      shots: [{ atMs: 0, camera: wide, target: null, reason: "static camera", events: [] }],
      warnings,
    };
  }

  const clusters: Cluster[] = [];
  for (const action of input.actions) {
    const target = WIDE_TYPES.has(action.type) ? null : targetOf(action, size);
    const isWide = target === null;
    const last = clusters.at(-1);
    const close = last && action.startMs - last.endMs <= tokens.clusterGapMs;
    if (last && close && last.wide && isWide) {
      last.endMs = Math.max(last.endMs, action.endMs);
      last.ids.push(action.id);
      last.types.push(action.type);
      continue;
    }
    if (last && close && !last.wide && !isWide) {
      const merged = fitCamera(union([...last.rects, target!]), size, tokens);
      if (merged.zoom >= tokens.minZoom) {
        last.rects.push(target!);
        last.endMs = Math.max(last.endMs, action.endMs);
        last.ids.push(action.id);
        last.types.push(action.type);
        continue;
      }
    }
    clusters.push({
      wide: isWide,
      rects: target ? [target] : [],
      startMs: action.startMs,
      endMs: action.endMs,
      ids: [action.id],
      types: [action.type],
    });
  }

  let shots: Shot[] = [
    { atMs: 0, camera: wide, target: null, reason: "establish the full view", events: [] },
  ];
  clusters.forEach((cluster, i) => {
    const at = Math.max(0, cluster.startMs - tokens.leadMs);
    const label = `${cluster.ids.length} ${cluster.ids.length === 1 ? "action" : "actions"} (${[...new Set(cluster.types)].join(", ")})`;
    if (cluster.wide) {
      shots.push({
        atMs: at,
        camera: wide,
        target: null,
        reason: `${label}: page-level, stay wide`,
        events: cluster.ids,
      });
    } else {
      const rect = union(cluster.rects);
      const camera = fitCamera(rect, size, tokens);
      const useful = camera.zoom >= tokens.minZoom;
      shots.push({
        atMs: at,
        camera: useful ? camera : wide,
        target: rect,
        reason: useful
          ? `${label}: frame the targets`
          : `${label}: targets span the screen, stay wide`,
        events: cluster.ids,
      });
    }
    const next = clusters[i + 1];
    const release = cluster.endMs + tokens.settleMs;
    const nextAt = next ? next.startMs - tokens.leadMs : input.durationMs;
    if (!cluster.wide && nextAt - release > tokens.returnAfterMs) {
      shots.push({
        atMs: release,
        camera: wide,
        target: null,
        reason: "nothing nearby next: return to the full view",
        events: [],
      });
    }
  });

  // A result that appeared after a wait is what the viewer came for: show
  // where the picture changed, or go wide when most of it did.
  for (const result of input.results ?? []) {
    const hinted = input.focus.some((f) => Math.abs(f.atMs - result.atMs) < 2000);
    const share = result.share ?? 0;
    if (hinted || (!result.region && share < 0.5)) continue;
    const at = Math.max(0, result.atMs - 100);
    const after = `${(result.delayMs / 1000).toFixed(1)} s after the action`;
    if (share >= 0.5 || !result.region) {
      shots.push({
        atMs: at,
        camera: wide,
        target: null,
        reason: `most of the screen changed ${after}: stay wide`,
        events: [result.actionId],
      });
      continue;
    }
    const camera = fitCamera(result.region, size, tokens);
    shots.push({
      atMs: at,
      camera: camera.zoom >= tokens.minZoom ? camera : wide,
      target: result.region,
      reason: `result appeared here ${after} (changed pixels)`,
      events: [result.actionId],
    });
  }

  // Focus hints win over action framing while they last.
  for (const focus of input.focus) {
    const from = Math.max(0, focus.atMs - 150);
    const until = focus.atMs + focus.durationMs;
    shots = shots.filter((s) => s.atMs <= from || s.atMs >= until);
    shots.push({
      atMs: from,
      camera: fitCamera(focus.rect, size, tokens),
      target: focus.rect,
      reason: `focus${focus.label ? `: ${focus.label}` : ""}`,
      events: [focus.id],
    });
    const after = shots.find((s) => s.atMs >= until);
    if (!after || after.atMs - until > tokens.returnAfterMs) {
      shots.push({
        atMs: until,
        camera: wide,
        target: null,
        reason: "focus ended: return to the full view",
        events: [],
      });
    }
  }

  shots.sort((a, b) => a.atMs - b.atMs);
  // A shot replaced before it settles is jitter: the later, more specific one
  // wins. Replacing the opening shot just starts the video already framed.
  const kept: Shot[] = [];
  for (const shot of shots) {
    const last = kept.at(-1);
    if (!last || shot.atMs - last.atMs >= tokens.minShotMs) {
      kept.push(shot);
      continue;
    }
    if (last.events.length > 0) {
      warnings.push(
        `Dropped a ${Math.round(shot.atMs - last.atMs)} ms shot (${last.reason}); it would never settle.`
      );
    }
    kept[kept.length - 1] = kept.length === 1 ? { ...shot, atMs: 0 } : shot;
  }
  // Consecutive identical framings collapse into one; keep every reason's events.
  const deduped: Shot[] = [];
  for (const shot of kept) {
    const last = deduped.at(-1);
    if (last && sameCamera(shot.camera, last.camera)) last.events.push(...shot.events);
    else deduped.push({ ...shot, events: [...shot.events] });
  }
  return { shots: deduped, warnings };
}

function sameCamera(a: Camera, b: Camera): boolean {
  return Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.zoom - b.zoom) < 0.01;
}

/** Fraction of `rect` visible in the camera's view: a reviewable framing check. */
export function coverage(camera: Camera, rect: Rect, size: Size): number {
  const viewW = size.width / camera.zoom;
  const viewH = size.height / camera.zoom;
  const left = camera.x - viewW / 2;
  const top = camera.y - viewH / 2;
  const w = Math.max(0, Math.min(left + viewW, rect.x + rect.width) - Math.max(left, rect.x));
  const h = Math.max(0, Math.min(top + viewH, rect.y + rect.height) - Math.max(top, rect.y));
  return rect.width * rect.height > 0 ? (w * h) / (rect.width * rect.height) : 0;
}
