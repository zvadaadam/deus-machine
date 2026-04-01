/**
 * Speed ramping and time compression for recordings.
 *
 * Implements Cursor-style playback plan generation:
 * - Action windows (clicks, typing, scrolling) play at 1x
 * - Idle gaps between actions are compressed (up to 8x)
 * - Leading/trailing dead time is trimmed
 *
 * The algorithm is adapted from Cursor's createPlaybackSegments()
 * to work with our ffmpeg-based pipeline (no Rust renderer).
 */

import type { AgentEvent } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PlaybackSegment {
  type: "action" | "gap";
  sourceStartMs: number;
  sourceEndMs: number;
  sourceDurationMs: number;
  outputStartMs: number;
  outputEndMs: number;
  outputDurationMs: number;
  /** 1.0 = normal speed, 4.0 = 4x fast-forward */
  playbackRate: number;
}

export interface PlaybackPlan {
  segments: PlaybackSegment[];
  outputDurationMs: number;
  /** Leading dead time trimmed from source (ms before first action window). */
  trimStartMs: number;
}

export interface SpeedRampConfig {
  /** Time to show before each action at 1x (ms). */
  preActionPaddingMs: number;
  /** Time to show after each action at 1x (ms). */
  postActionPaddingMs: number;
  /** Target output duration for compressed gaps (ms). */
  targetGapOutputMs: number;
  /** Maximum output duration for any gap (ms). */
  maxGapOutputMs: number;
  /** Maximum playback rate for gap compression. */
  maxPlaybackRate: number;
  /** Minimum gap duration to trigger compression (ms). Shorter gaps stay at 1x. */
  minGapToSpeedUp: number;
}

export const DEFAULT_SPEED_RAMP_CONFIG: SpeedRampConfig = {
  preActionPaddingMs: 600,
  postActionPaddingMs: 400,
  targetGapOutputMs: 1200,
  maxGapOutputMs: 2000,
  maxPlaybackRate: 8,
  minGapToSpeedUp: 800,
};

// ---------------------------------------------------------------------------
// Event filtering
// ---------------------------------------------------------------------------

/** Actions that represent meaningful user/agent interaction. */
export function isMeaningfulAction(event: AgentEvent): boolean {
  switch (event.type) {
    case "click":
    case "type":
    case "scroll":
    case "navigate":
    case "drag":
      return true;
    case "idle":
    case "screenshot":
      return false;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Playback plan generation
// ---------------------------------------------------------------------------

interface ActionWindow {
  start: number;
  end: number;
}

/**
 * Create a playback plan from agent events.
 *
 * Action windows play at 1x speed. Gaps between actions are compressed
 * based on their duration. Leading dead time before the first action is trimmed.
 */
export function createPlaybackPlan(
  events: AgentEvent[],
  sourceDurationMs: number,
  config?: Partial<SpeedRampConfig>
): PlaybackPlan {
  const cfg = { ...DEFAULT_SPEED_RAMP_CONFIG, ...config };

  // Extract and sort meaningful action timestamps, clamped to source duration.
  // Event timestamps are relative to session start, but the raw video may be
  // shorter than the session (frames only arrive while streaming is active).
  const timestamps = events
    .filter(isMeaningfulAction)
    .map((e) => e.t)
    .filter((t) => t < sourceDurationMs)
    .sort((a, b) => a - b);

  // No actions — single segment at 1x
  if (timestamps.length === 0) {
    return {
      segments: [
        {
          type: "gap",
          sourceStartMs: 0,
          sourceEndMs: sourceDurationMs,
          sourceDurationMs: sourceDurationMs,
          outputStartMs: 0,
          outputEndMs: sourceDurationMs,
          outputDurationMs: sourceDurationMs,
          playbackRate: 1,
        },
      ],
      outputDurationMs: sourceDurationMs,
      trimStartMs: 0,
    };
  }

  // Build action windows with padding, merged when overlapping
  const actionWindows: ActionWindow[] = [];
  for (const ts of timestamps) {
    const start = Math.max(0, ts - cfg.preActionPaddingMs);
    const end = Math.min(sourceDurationMs, ts + cfg.postActionPaddingMs);

    if (actionWindows.length > 0) {
      const last = actionWindows[actionWindows.length - 1];
      if (start <= last.end) {
        last.end = Math.max(last.end, end);
        continue;
      }
    }
    actionWindows.push({ start, end });
  }

  // Build segments
  const segments: PlaybackSegment[] = [];
  let outputTime = 0;
  let lastSourceEnd = 0;

  const maxGap =
    Number.isFinite(cfg.maxGapOutputMs) && cfg.maxGapOutputMs > 0
      ? cfg.maxGapOutputMs
      : Number.POSITIVE_INFINITY;

  for (const window of actionWindows) {
    // Gap before this action window
    if (window.start > lastSourceEnd) {
      const gap = buildGapSegment(lastSourceEnd, window.start, outputTime, cfg, maxGap);
      segments.push(gap);
      outputTime += gap.outputDurationMs;
    }

    // Action window at 1x
    const actionDuration = window.end - window.start;
    segments.push({
      type: "action",
      sourceStartMs: window.start,
      sourceEndMs: window.end,
      sourceDurationMs: actionDuration,
      outputStartMs: outputTime,
      outputEndMs: outputTime + actionDuration,
      outputDurationMs: actionDuration,
      playbackRate: 1,
    });
    outputTime += actionDuration;
    lastSourceEnd = window.end;
  }

  // Trailing gap after last action
  if (lastSourceEnd < sourceDurationMs) {
    const gap = buildGapSegment(lastSourceEnd, sourceDurationMs, outputTime, cfg, maxGap);
    segments.push(gap);
    outputTime += gap.outputDurationMs;
  }

  // Compute trim: everything before first action - padding
  const trimStartMs = Math.max(0, timestamps[0] - cfg.preActionPaddingMs);

  return {
    segments,
    outputDurationMs: outputTime,
    trimStartMs,
  };
}

function buildGapSegment(
  sourceStart: number,
  sourceEnd: number,
  outputStart: number,
  cfg: SpeedRampConfig,
  maxGap: number
): PlaybackSegment {
  const gapSourceDuration = sourceEnd - sourceStart;
  let playbackRate = 1;
  let gapOutputDuration = gapSourceDuration;

  if (gapSourceDuration > cfg.minGapToSpeedUp) {
    const idealRate = gapSourceDuration / cfg.targetGapOutputMs;
    const minRateForMaxWait = maxGap === Number.POSITIVE_INFINITY ? 0 : gapSourceDuration / maxGap;
    const effectiveMax = cfg.maxPlaybackRate;
    playbackRate = Math.max(Math.min(idealRate, effectiveMax), minRateForMaxWait);
    gapOutputDuration = gapSourceDuration / playbackRate;
  }

  return {
    type: "gap",
    sourceStartMs: sourceStart,
    sourceEndMs: sourceEnd,
    sourceDurationMs: gapSourceDuration,
    outputStartMs: outputStart,
    outputEndMs: outputStart + gapOutputDuration,
    outputDurationMs: gapOutputDuration,
    playbackRate,
  };
}

// ---------------------------------------------------------------------------
// Time mapping
// ---------------------------------------------------------------------------

/** Map a source timestamp to the corresponding output timestamp. */
export function sourceToOutputTime(sourceTimeMs: number, segments: PlaybackSegment[]): number {
  for (const seg of segments) {
    if (sourceTimeMs >= seg.sourceStartMs && sourceTimeMs <= seg.sourceEndMs) {
      const sourceOffset = sourceTimeMs - seg.sourceStartMs;
      const outputOffset = sourceOffset / seg.playbackRate;
      return seg.outputStartMs + outputOffset;
    }
  }
  // Beyond all segments — return last end
  if (segments.length > 0) {
    return segments[segments.length - 1].outputEndMs;
  }
  return 0;
}

export interface MappedEvent {
  type: string;
  /** Time in output video seconds */
  time: number;
  text?: string;
  url?: string;
  direction?: string;
}

export interface MappedChapter {
  title: string;
  /** Time in output video seconds */
  time: number;
}

/** Map an output timestamp to the corresponding source timestamp. */
export function outputToSourceTime(outputTimeMs: number, segments: PlaybackSegment[]): number {
  for (const seg of segments) {
    if (outputTimeMs >= seg.outputStartMs && outputTimeMs <= seg.outputEndMs) {
      const outputOffset = outputTimeMs - seg.outputStartMs;
      const sourceOffset = outputOffset * seg.playbackRate;
      return seg.sourceStartMs + sourceOffset;
    }
  }
  if (segments.length > 0) {
    return segments[segments.length - 1].sourceEndMs;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Timeline mapping
// ---------------------------------------------------------------------------

/**
 * Map raw events and chapters to output video timestamps.
 * Uses the playback plan's speed ramp segments for accurate mapping.
 * If no plan provided, maps 1:1 (source time = output time).
 */
export function mapTimelineToOutput(
  events: AgentEvent[],
  chapters: { title: string; timestamp: number; eventIndex: number }[],
  plan: PlaybackPlan | null
): { events: MappedEvent[]; chapters: MappedChapter[] } {
  const mapTime = (sourceMs: number): number => {
    if (!plan) return sourceMs / 1000;
    return sourceToOutputTime(sourceMs, plan.segments) / 1000;
  };

  return {
    events: events.map((e) => ({
      type: e.type,
      time: mapTime(e.t),
      ...(e.meta?.text ? { text: String(e.meta.text) } : {}),
      ...(e.meta?.url ? { url: String(e.meta.url) } : {}),
      ...(e.meta?.direction ? { direction: String(e.meta.direction) } : {}),
    })),
    chapters: chapters.map((c) => ({
      title: c.title,
      time: mapTime(c.timestamp),
    })),
  };
}
