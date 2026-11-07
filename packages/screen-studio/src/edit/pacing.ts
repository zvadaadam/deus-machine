/**
 * Pacing: decide which parts of a recording play in real time.
 *
 * Kept at 1×: every action from shortly before it starts until a reading
 * margin after it completes (so its result is seen), agent holds, focus
 * hints, and the first moments of each chapter. Everything else is a gap.
 * Gaps speed up — still footage much more than moving footage, because "no
 * input" does not mean "nothing happening" — and when a gap would still run
 * over its budget, its middle is cut, keeping the moments on either side.
 */
import { ScreenStudioError } from "../errors.js";
import { EditMap, type SegmentInput } from "./edit-map.js";
import type { MotionAnalysis } from "./motion.js";
import { findResults } from "./results.js";
import type { Timeline } from "./timeline.js";

export type PacingMode = "preserve" | "compress" | "cut";

export interface PacingTokens {
  /** Shown before an action starts. */
  preRollMs: number;
  /** Shown after an action completes: the result and time to read it. */
  postRollMs: number;
  chapterLeadMs: number;
  chapterHoldMs: number;
  focusLeadMs: number;
  /** Gaps shorter than this play normally. */
  minGapMs: number;
  /** Playback rate for still footage. */
  stillRate: number;
  /** Playback rate for footage that moves (animations, loaders). */
  motionRate: number;
  /** Most output time an interior gap may take; the middle beyond it is cut. */
  gapBudgetMs: number;
  /** Before the first kept moment. */
  leadBudgetMs: number;
  /** After the last kept moment. */
  tailBudgetMs: number;
}

export const PACING_LEVELS: Record<"compress" | "cut" | "tight", PacingTokens> = {
  compress: {
    preRollMs: 700,
    postRollMs: 1200,
    chapterLeadMs: 300,
    chapterHoldMs: 1200,
    focusLeadMs: 300,
    minGapMs: 900,
    stillRate: 6,
    motionRate: 2,
    gapBudgetMs: 2000,
    leadBudgetMs: 800,
    tailBudgetMs: 1500,
  },
  cut: {
    preRollMs: 500,
    postRollMs: 1000,
    chapterLeadMs: 200,
    chapterHoldMs: 1000,
    focusLeadMs: 200,
    minGapMs: 700,
    stillRate: 8,
    motionRate: 3,
    gapBudgetMs: 600,
    leadBudgetMs: 200,
    tailBudgetMs: 900,
  },
  tight: {
    preRollMs: 300,
    postRollMs: 700,
    chapterLeadMs: 100,
    chapterHoldMs: 700,
    focusLeadMs: 100,
    minGapMs: 500,
    stillRate: 8,
    motionRate: 4,
    gapBudgetMs: 300,
    leadBudgetMs: 0,
    tailBudgetMs: 500,
  },
};

export interface PacingOptions {
  mode: PacingMode;
  /** A request, not a promise: reported as unmet when kept content alone is longer. */
  targetDurationMs?: number;
  motion?: MotionAnalysis | null;
  tokens?: Partial<PacingTokens>;
}

export interface PacingPlan {
  map: EditMap;
  mode: PacingMode;
  level: "preserve" | keyof typeof PACING_LEVELS;
  targetDurationMs?: number;
  targetMet?: boolean;
  /** Source time kept at 1× (actions, holds, focus, chapter openings). */
  keptMs: number;
  warnings: string[];
}

interface Span {
  startMs: number;
  endMs: number;
}

export function planPacing(timeline: Timeline, options: PacingOptions): PacingPlan {
  const duration = timeline.durationMs;
  if (options.mode === "preserve") {
    return {
      map: EditMap.identity(duration),
      mode: "preserve",
      level: "preserve",
      keptMs: duration,
      warnings: [],
    };
  }
  const order: Array<keyof typeof PACING_LEVELS> =
    options.mode === "compress" ? ["compress", "cut", "tight"] : ["cut", "tight"];
  const levels = options.targetDurationMs === undefined ? order.slice(0, 1) : order;
  let plan: PacingPlan | null = null;
  for (const level of levels) {
    plan = planLevel(timeline, options, level);
    if (
      options.targetDurationMs === undefined ||
      plan.map.outputDurationMs <= options.targetDurationMs
    )
      break;
  }
  if (!plan) throw new ScreenStudioError("invalid_argument", "No pacing level");
  if (options.targetDurationMs !== undefined) {
    plan.targetDurationMs = options.targetDurationMs;
    plan.targetMet = plan.map.outputDurationMs <= options.targetDurationMs;
    if (!plan.targetMet) {
      plan.warnings.push(
        `Target ${(options.targetDurationMs / 1000).toFixed(1)} s is not reachable without cutting actions or ` +
          `their results; the tightest edit is ${(plan.map.outputDurationMs / 1000).toFixed(1)} s.`
      );
    }
  }
  return plan;
}

function planLevel(
  timeline: Timeline,
  options: PacingOptions,
  level: keyof typeof PACING_LEVELS
): PacingPlan {
  const t: PacingTokens = { ...PACING_LEVELS[level], ...options.tokens };
  const duration = timeline.durationMs;
  const warnings: string[] = [];
  const still = stillRanges(timeline, options.motion ?? null);

  let keeps: Span[] = [
    ...timeline.actions.map((a) => ({
      startMs: a.startMs - t.preRollMs,
      endMs: a.endMs + t.postRollMs,
    })),
    ...timeline.holds.map((h) => ({ startMs: h.atMs, endMs: h.atMs + h.durationMs })),
    ...timeline.focus.map((f) => ({
      startMs: f.atMs - t.focusLeadMs,
      endMs: f.atMs + f.durationMs,
    })),
    ...timeline.chapters.map((c) => ({
      startMs: c.atMs - t.chapterLeadMs,
      endMs: c.atMs + t.chapterHoldMs,
    })),
    // The answer to an action that arrived after a wait: show it arriving.
    ...findResults(timeline, options.motion ?? null).map((r) => ({
      startMs: r.atMs - 250,
      endMs: r.atMs + t.postRollMs + 300,
    })),
  ];
  if (keeps.length === 0) {
    if (!options.motion) {
      return {
        map: EditMap.fromSpans(
          carveUnseen(
            [
              {
                sourceStartMs: 0,
                sourceEndMs: duration,
                rate: 1,
                reason: "no actions or motion analysis to pace by",
              },
            ],
            timeline
          ),
          duration
        ),
        mode: options.mode,
        level,
        keptMs: duration,
        warnings: ["No actions, markers, or motion analysis: kept original timing."],
      };
    }
    // Video only: what moves is the content; only still stretches are gaps.
    keeps = invert(still, duration).map((s) => ({
      startMs: s.startMs - 200,
      endMs: s.endMs + 200,
    }));
    warnings.push("No actions or markers: pacing from motion alone.");
  }
  keeps = mergeSpans(clampSpans(keeps, duration), t.minGapMs);
  const keptMs = keeps.reduce((sum, s) => sum + s.endMs - s.startMs, 0);

  const spans: SegmentInput[] = [];
  let cursor = 0;
  keeps.forEach((keep, index) => {
    if (keep.startMs > cursor) {
      spans.push(
        ...paceGap(
          { startMs: cursor, endMs: keep.startMs },
          index === 0 ? "lead" : "interior",
          t,
          still
        )
      );
    }
    spans.push({
      sourceStartMs: keep.startMs,
      sourceEndMs: keep.endMs,
      rate: 1,
      reason: "action or marker",
    });
    cursor = keep.endMs;
  });
  if (cursor < duration)
    spans.push(...paceGap({ startMs: cursor, endMs: duration }, "tail", t, still));

  return {
    map: EditMap.fromSpans(carveUnseen(spans, timeline), duration),
    mode: options.mode,
    level,
    keptMs,
    warnings,
  };
}

/** A frozen frame says nothing: spans where the source was not painted are cut. */
function carveUnseen(spans: SegmentInput[], timeline: Timeline): SegmentInput[] {
  const holes = mergeSpans(
    timeline.unseen.map((u) => ({ startMs: u.startMs, endMs: u.endMs })),
    0
  );
  if (!holes.length) return spans;
  const out: SegmentInput[] = [];
  for (const span of spans) {
    let pieces = [{ start: span.sourceStartMs, end: span.sourceEndMs }];
    for (const hole of holes) {
      pieces = pieces.flatMap((p) =>
        hole.endMs <= p.start || hole.startMs >= p.end
          ? [p]
          : [
              ...(hole.startMs > p.start ? [{ start: p.start, end: hole.startMs }] : []),
              ...(hole.endMs < p.end ? [{ start: hole.endMs, end: p.end }] : []),
            ]
      );
    }
    out.push(...pieces.map((p) => ({ ...span, sourceStartMs: p.start, sourceEndMs: p.end })));
  }
  for (const hole of holes) {
    out.push({
      sourceStartMs: hole.startMs,
      sourceEndMs: hole.endMs,
      rate: null,
      reason: "not painted: frozen picture",
    });
  }
  return out.sort((a, b) => a.sourceStartMs - b.sourceStartMs);
}

type GapEdge = "lead" | "interior" | "tail";

interface Part extends Span {
  still: boolean;
}

function paceGap(gap: Span, edge: GapEdge, t: PacingTokens, still: Span[]): SegmentInput[] {
  const length = gap.endMs - gap.startMs;
  const budget =
    edge === "lead" ? t.leadBudgetMs : edge === "tail" ? t.tailBudgetMs : t.gapBudgetMs;
  if (edge === "interior" && length < t.minGapMs) {
    return [{ sourceStartMs: gap.startMs, sourceEndMs: gap.endMs, rate: 1, reason: "short pause" }];
  }
  const parts = splitByStill(gap, still);
  const rateOf = (p: Part) => (p.still ? t.stillRate : t.motionRate);
  const outputOf = (p: Part) => (p.endMs - p.startMs) / rateOf(p);
  const total = parts.reduce((sum, p) => sum + outputOf(p), 0);
  const describe = (p: Part) => (p.still ? "still wait, sped up" : "motion without input, sped up");
  if (total <= budget) {
    return parts.map((p) => ({
      sourceStartMs: p.startMs,
      sourceEndMs: p.endMs,
      rate: rateOf(p),
      reason: describe(p),
    }));
  }

  // Over budget: keep a sped-up head and tail around a jump cut. The lead
  // keeps only what precedes the first action; the tail only what follows
  // the last one.
  const headBudget = edge === "lead" ? 0 : edge === "tail" ? budget : budget / 2;
  const tailBudget = edge === "lead" ? budget : edge === "tail" ? 0 : budget / 2;
  const head = takeOutput(parts, headBudget, rateOf, "forward");
  const tail = takeOutput(parts, tailBudget, rateOf, "backward");
  const cutStart = head.at(-1)?.sourceEndMs ?? gap.startMs;
  const cutEnd = tail[0]?.sourceStartMs ?? gap.endMs;
  const spans: SegmentInput[] = [...head];
  if (cutEnd > cutStart) {
    spans.push({
      sourceStartMs: cutStart,
      sourceEndMs: cutEnd,
      rate: null,
      reason: `cut ${((cutEnd - cutStart) / 1000).toFixed(1)} s of waiting`,
    });
  }
  spans.push(...tail);
  return spans;

  function takeOutput(
    list: Part[],
    budgetMs: number,
    rate: (p: Part) => number,
    direction: "forward" | "backward"
  ): SegmentInput[] {
    const taken: SegmentInput[] = [];
    let left = budgetMs;
    const ordered = direction === "forward" ? list : [...list].reverse();
    for (const part of ordered) {
      if (left <= 0) break;
      const r = rate(part);
      const sourceNeeded = Math.min(part.endMs - part.startMs, left * r);
      const span =
        direction === "forward"
          ? { sourceStartMs: part.startMs, sourceEndMs: part.startMs + sourceNeeded }
          : { sourceStartMs: part.endMs - sourceNeeded, sourceEndMs: part.endMs };
      taken.push({ ...span, rate: r, reason: describe(part) });
      left -= sourceNeeded / r;
    }
    return direction === "forward" ? taken : taken.reverse();
  }
}

/** Still ranges, including the padded tail past the end of sparse media. */
function stillRanges(timeline: Timeline, motion: MotionAnalysis | null): Span[] {
  if (!motion) return [{ startMs: 0, endMs: timeline.durationMs }];
  const ranges = motion.stillRanges.map((r) => ({ startMs: r.startMs, endMs: r.endMs }));
  if (timeline.durationMs > timeline.mediaDurationMs) {
    ranges.push({ startMs: timeline.mediaDurationMs, endMs: timeline.durationMs });
  }
  return mergeSpans(ranges, 0);
}

function splitByStill(gap: Span, still: Span[]): Part[] {
  const parts: Part[] = [];
  let cursor = gap.startMs;
  for (const range of still) {
    if (range.endMs <= cursor) continue;
    if (range.startMs >= gap.endMs) break;
    if (range.startMs > cursor) parts.push({ startMs: cursor, endMs: range.startMs, still: false });
    const end = Math.min(range.endMs, gap.endMs);
    parts.push({ startMs: Math.max(range.startMs, cursor), endMs: end, still: true });
    cursor = end;
  }
  if (cursor < gap.endMs) parts.push({ startMs: cursor, endMs: gap.endMs, still: false });
  return parts.filter((p) => p.endMs - p.startMs > 0.5);
}

function clampSpans(spans: Span[], duration: number): Span[] {
  return spans
    .map((s) => ({ startMs: Math.max(0, s.startMs), endMs: Math.min(duration, s.endMs) }))
    .filter((s) => s.endMs > s.startMs);
}

/** Merge spans that overlap or are separated by less than `minGapMs`. */
export function mergeSpans(spans: Span[], minGapMs: number): Span[] {
  const sorted = [...spans].sort((a, b) => a.startMs - b.startMs);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged.at(-1);
    if (last && span.startMs - last.endMs < minGapMs) last.endMs = Math.max(last.endMs, span.endMs);
    else merged.push({ ...span });
  }
  return merged;
}

function invert(spans: Span[], duration: number): Span[] {
  const out: Span[] = [];
  let cursor = 0;
  for (const span of mergeSpans(spans, 0)) {
    if (span.startMs > cursor) out.push({ startMs: cursor, endMs: span.startMs });
    cursor = Math.max(cursor, span.endMs);
  }
  if (cursor < duration) out.push({ startMs: cursor, endMs: duration });
  return out;
}
