/**
 * The edit map: how source (media) time becomes output time.
 *
 * Pixels, camera, cursor, chapters and event times in a rendition are all
 * derived from this one object, so they cannot drift apart. FFmpeg retimes the
 * pixels from `ffmpegFilter()`; everything else uses `toOutput()`/`toSource()`.
 */
export type SegmentKind = "keep" | "speed" | "cut";

export interface EditSegment {
  kind: SegmentKind;
  sourceStartMs: number;
  sourceEndMs: number;
  outputStartMs: number;
  /** Equal to outputStartMs for a cut. */
  outputEndMs: number;
  /** Playback rate; null for a cut. */
  rate: number | null;
  reason: string;
}

export interface SegmentInput {
  sourceStartMs: number;
  sourceEndMs: number;
  /** 1 keeps real time, >1 speeds up, null cuts the span. */
  rate: number | null;
  reason: string;
}

const EPSILON = 0.5;

export class EditMap {
  readonly segments: readonly EditSegment[];
  readonly sourceDurationMs: number;

  private constructor(segments: EditSegment[], sourceDurationMs: number) {
    this.segments = segments;
    this.sourceDurationMs = sourceDurationMs;
  }

  static identity(durationMs: number, reason = "original timing"): EditMap {
    return EditMap.fromSpans(
      [{ sourceStartMs: 0, sourceEndMs: durationMs, rate: 1, reason }],
      durationMs
    );
  }

  /**
   * Build from contiguous spans covering 0..sourceDurationMs. Adjacent spans
   * with the same rate merge, which keeps the FFmpeg graph small.
   */
  static fromSpans(spans: SegmentInput[], sourceDurationMs: number): EditMap {
    const sorted = spans
      .filter((s) => s.sourceEndMs - s.sourceStartMs > EPSILON)
      .sort((a, b) => a.sourceStartMs - b.sourceStartMs);
    const merged: SegmentInput[] = [];
    for (const span of sorted) {
      const last = merged.at(-1);
      if (
        last &&
        Math.abs(last.sourceEndMs - span.sourceStartMs) <= EPSILON &&
        sameRate(last.rate, span.rate)
      ) {
        last.sourceEndMs = span.sourceEndMs;
        if (!last.reason.includes(span.reason)) last.reason = `${last.reason}; ${span.reason}`;
      } else {
        merged.push({ ...span });
      }
    }
    let output = 0;
    const segments = merged.map((span): EditSegment => {
      const length = span.sourceEndMs - span.sourceStartMs;
      const outLength = span.rate === null ? 0 : length / span.rate;
      const segment: EditSegment = {
        kind: span.rate === null ? "cut" : span.rate === 1 ? "keep" : "speed",
        sourceStartMs: round(span.sourceStartMs),
        sourceEndMs: round(span.sourceEndMs),
        outputStartMs: round(output),
        outputEndMs: round(output + outLength),
        rate: span.rate === null ? null : round(span.rate, 3),
        reason: span.reason,
      };
      output += outLength;
      return segment;
    });
    return new EditMap(segments, sourceDurationMs);
  }

  get outputDurationMs(): number {
    return this.segments.at(-1)?.outputEndMs ?? 0;
  }

  get isIdentity(): boolean {
    return this.segments.length === 1 && this.segments[0].rate === 1;
  }

  /** Map source time to output time. Times inside a cut land where the cut is. */
  toOutput(sourceMs: number): { ms: number; cut: boolean } {
    for (const segment of this.segments) {
      if (sourceMs > segment.sourceEndMs) continue;
      if (sourceMs < segment.sourceStartMs) return { ms: segment.outputStartMs, cut: true };
      if (segment.rate === null) return { ms: segment.outputStartMs, cut: true };
      return {
        ms: segment.outputStartMs + (sourceMs - segment.sourceStartMs) / segment.rate,
        cut: false,
      };
    }
    return { ms: this.outputDurationMs, cut: sourceMs > this.sourceDurationMs + EPSILON };
  }

  toSource(outputMs: number): number {
    for (const segment of this.segments) {
      if (segment.rate === null || outputMs > segment.outputEndMs) continue;
      return segment.sourceStartMs + Math.max(0, outputMs - segment.outputStartMs) * segment.rate;
    }
    const last = this.segments.filter((s) => s.rate !== null).at(-1);
    return last ? last.sourceEndMs : 0;
  }

  /** Playback rate at an output time (1 when unknown). */
  rateAt(outputMs: number): number {
    for (const segment of this.segments) {
      if (segment.rate === null || outputMs > segment.outputEndMs) continue;
      return segment.rate;
    }
    return 1;
  }

  /**
   * FFmpeg filtergraph from `[0:v]` to `[out]`: zero-based constant-rate
   * timestamps, the capture window padded by holding the last frame (sparse
   * sources end early),
   * one trim per shown segment, concatenated at a constant output rate.
   */
  ffmpegFilter(options: {
    fps: number;
    mediaDurationMs: number;
    prefilter?: string;
    postfilter?: string;
  }): string {
    const shown = this.segments.filter((s) => s.rate !== null);
    const padMs = Math.max(0, this.sourceDurationMs - options.mediaDurationMs) + 250;
    const head = [
      "setpts=PTS-STARTPTS",
      // Constant rate first: sparse sources (simctl writes frames only on
      // change) hold each frame until the next, and tpad needs a fixed rate.
      `fps=${options.fps}`,
      `tpad=stop_mode=clone:stop_duration=${(padMs / 1000).toFixed(3)}`,
      ...(options.prefilter ? [options.prefilter] : []),
    ].join(",");
    // Retime on a fine timebase: dividing timestamps that sit on the 1/fps
    // clock would round sped-up frames onto each other and drop them.
    const trim = (s: EditSegment) =>
      `trim=start=${sec(s.sourceStartMs)}:end=${sec(s.sourceEndMs)},settb=1/90000,setpts=(PTS-STARTPTS)/${s.rate}`;
    const tail = [
      `fps=${options.fps}`,
      "setsar=1",
      ...(options.postfilter ? [options.postfilter] : []),
    ].join(",");
    if (shown.length === 1) return `[0:v]${head},${trim(shown[0])},${tail}[out]`;
    const labels = shown.map((_, i) => `[s${i}]`).join("");
    const branches = shown.map((s, i) => `[s${i}]${trim(s)}[v${i}]`);
    const inputs = shown.map((_, i) => `[v${i}]`).join("");
    return [
      `[0:v]${head},split=${shown.length}${labels}`,
      ...branches,
      `${inputs}concat=n=${shown.length}:v=1:a=0,${tail}[out]`,
    ].join(";");
  }

  toJSON(): {
    sourceDurationMs: number;
    outputDurationMs: number;
    segments: readonly EditSegment[];
  } {
    return {
      sourceDurationMs: this.sourceDurationMs,
      outputDurationMs: this.outputDurationMs,
      segments: this.segments,
    };
  }
}

function sameRate(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) < 1e-6;
}

function round(value: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function sec(ms: number): string {
  return (ms / 1000).toFixed(4);
}
