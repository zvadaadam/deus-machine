/**
 * The recording bundle contract.
 *
 * A bundle is an ordinary directory an editor can understand without this
 * package: the original media, plus JSON describing where it came from, how
 * its clock maps to the machine clock, and what happened while it recorded.
 *
 *   manifest.json   capture facts (source, clock, geometry, media, outcome)
 *   events.jsonl    append-only evidence and intent: actions, chapters, holds, focus
 *   media/          the original capture, never modified after finalization
 *   analysis/       derived, replaceable (e.g. motion ranges)
 *   renders/        exported renditions, each with its edit map and chapters
 */
import { z } from "zod";

export const BUNDLE_FORMAT = "screen-studio/bundle";
export const BUNDLE_VERSION = 1;

export const SizeSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
});

export const PointSchema = z.object({ x: z.number(), y: z.number() });

export const RectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});

export const SourceKindSchema = z.enum([
  "browser",
  "ios-simulator",
  "display",
  "test-pattern",
  "file",
]);

export const CaptureStatusSchema = z.enum([
  "starting",
  "recording",
  "finalizing",
  "complete",
  "failed",
]);

export const StopReasonSchema = z.enum([
  "requested",
  "deadline",
  "size-limit",
  "source-lost",
  "signal",
  "error",
  "owner-lost",
]);

const ErrorInfoSchema = z.object({
  code: z.string(),
  message: z.string(),
  hint: z.string().optional(),
});

export const ManifestSchema = z.object({
  format: z.literal(BUNDLE_FORMAT),
  version: z.literal(BUNDLE_VERSION),
  id: z.string(),
  createdAt: z.string(),
  status: CaptureStatusSchema,
  source: z.object({
    /** The source ID as requested, e.g. `browser:http://127.0.0.1:9222`. */
    id: z.string(),
    kind: SourceKindSchema,
    /** The capture implementation: cdp-screencast, simctl, avfoundation, lavfi, import. */
    backend: z.string(),
    label: z.string(),
    details: z.record(z.unknown()).default({}),
  }),
  capture: z.object({
    fps: z.number().positive(),
    maxDurationMs: z.number().positive(),
    maxBytes: z.number().positive(),
    /** Epoch ms when start was requested. */
    requestedAt: z.number(),
    /** Epoch ms of media time zero. Equal to `clock.mediaStartEpochMs`. */
    startedAt: z.number().optional(),
    /** Epoch ms when capture stopped; the capture window is startedAt..stoppedAt. */
    stoppedAt: z.number().optional(),
    stopReason: StopReasonSchema.optional(),
    /** The process that owns the live recorder (CLI worker or host app). */
    owner: z
      .object({
        // Signalled as a process group on recovery: never 0, 1 or negative.
        pid: z.number().int().min(2),
        hostname: z.string(),
        token: z.string(),
        /**
         * worker: a detached CLI worker, safe to signal. host: an app or MCP
         * server recording in-process — never signalled from outside.
         */
        kind: z.enum(["worker", "host"]).default("host"),
        childPids: z.array(z.number().int().min(2)).default([]),
      })
      .optional(),
    progress: z.object({ frames: z.number(), bytes: z.number(), updatedAt: z.number() }).optional(),
    warnings: z.array(z.string()).default([]),
    error: ErrorInfoSchema.optional(),
  }),
  /**
   * Event `at` values and media time share the recording machine's wall clock:
   * mediaTimeMs = at - mediaStartEpochMs. `uncertaintyMs` bounds how far media
   * time zero may be from the first frame actually shown.
   */
  clock: z
    .object({
      mediaStartEpochMs: z.number(),
      uncertaintyMs: z.number().nonnegative(),
      method: z.string(),
    })
    .optional(),
  geometry: z
    .object({
      /** Coordinate space actions use by default: CSS px, iOS points, display points. */
      viewport: SizeSchema,
      /** Pixel size of the media. */
      media: SizeSchema,
    })
    .optional(),
  media: z
    .object({
      /** Relative to the bundle directory. */
      path: z.string(),
      sha256: z.string(),
      bytes: z.number(),
      durationMs: z.number(),
      width: z.number(),
      height: z.number(),
      codec: z.string(),
      frameRate: z.string(),
      frames: z.number().optional(),
      audio: z.boolean(),
      /** Whether a pointer or touch overlay is already burned into the pixels. */
      pointerInPixels: z.enum(["none", "system-cursor", "touches", "unknown"]),
    })
    .optional(),
});

export type Manifest = z.infer<typeof ManifestSchema>;
export type SourceKind = z.infer<typeof SourceKindSchema>;
export type CaptureStatus = z.infer<typeof CaptureStatusSchema>;
export type StopReason = z.infer<typeof StopReasonSchema>;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const ACTION_TYPES = [
  "click",
  "double-click",
  "right-click",
  "hover",
  "type",
  "key",
  "scroll",
  "navigate",
  "drag",
  "tap",
  "long-press",
  "swipe",
  "pinch",
  "other",
] as const;

const EventBase = {
  id: z.string(),
  /** Epoch ms on the recording machine's clock. */
  at: z.number(),
  /** Who reported it: cli, deus-browser, agent-device, … */
  by: z.string().max(80).optional(),
};

/**
 * Coordinate reference for point/rect/path. Defaults to the manifest's
 * viewport; a tool that reports in another space (e.g. iOS points from a
 * 402×874 reference) states it here and the renderer scales.
 */
const SpaceSchema = SizeSchema.optional();

export const ActionEventSchema = z.object({
  kind: z.literal("action"),
  ...EventBase,
  type: z.enum(ACTION_TYPES),
  /** Epoch ms when the action completed (tool returned, result observed). */
  endAt: z.number().optional(),
  point: PointSchema.optional(),
  rect: RectSchema.optional(),
  /** Drag or swipe trajectory. */
  path: z.array(PointSchema).max(500).optional(),
  space: SpaceSchema,
  label: z.string().max(200).optional(),
  /** Typed text. Only stored when the caller opts in. */
  text: z.string().max(2000).optional(),
  url: z.string().max(2000).optional(),
  outcome: z.enum(["ok", "error"]).optional(),
});

export const ChapterEventSchema = z.object({
  kind: z.literal("chapter"),
  ...EventBase,
  title: z.string().min(1).max(200),
});

/** "Keep this moment at normal speed": loading results, reading time. */
export const HoldEventSchema = z.object({
  kind: z.literal("hold"),
  ...EventBase,
  durationMs: z.number().positive().max(60_000),
  reason: z.string().max(200).optional(),
});

/** "Show this region": a semantic camera hint, not camera coordinates. */
export const FocusEventSchema = z.object({
  kind: z.literal("focus"),
  ...EventBase,
  rect: RectSchema,
  space: SpaceSchema,
  durationMs: z.number().positive().max(60_000).optional(),
  label: z.string().max(200).optional(),
});

export const NoteEventSchema = z.object({
  kind: z.literal("note"),
  ...EventBase,
  text: z.string().min(1).max(2000),
});

/** Written by the recorder when the source's viewport changes size. */
export const GeometryEventSchema = z.object({
  kind: z.literal("geometry"),
  ...EventBase,
  viewport: SizeSchema,
});

/**
 * The source was not painting (a hidden tab, a minimized window): the media
 * holds a frozen frame from `at` to `endAt`. Edits cut it.
 */
export const UnseenEventSchema = z.object({
  kind: z.literal("unseen"),
  ...EventBase,
  endAt: z.number(),
  reason: z.string().max(200),
});

export const BundleEventSchema = z.discriminatedUnion("kind", [
  ActionEventSchema,
  ChapterEventSchema,
  HoldEventSchema,
  FocusEventSchema,
  NoteEventSchema,
  GeometryEventSchema,
  UnseenEventSchema,
]);

export type BundleEvent = z.infer<typeof BundleEventSchema>;
export type ActionEvent = z.infer<typeof ActionEventSchema>;
export type ChapterEvent = z.infer<typeof ChapterEventSchema>;
export type HoldEvent = z.infer<typeof HoldEventSchema>;
export type FocusEvent = z.infer<typeof FocusEventSchema>;
export type NoteEvent = z.infer<typeof NoteEventSchema>;
export type GeometryEvent = z.infer<typeof GeometryEventSchema>;
export type UnseenEvent = z.infer<typeof UnseenEventSchema>;
export type ActionType = (typeof ACTION_TYPES)[number];
export type Rect = z.infer<typeof RectSchema>;
export type Point = z.infer<typeof PointSchema>;

/** An event as submitted: the bundle assigns `id`, and `at` defaults to now. */
export type EventInput = BundleEvent extends infer E
  ? E extends BundleEvent
    ? Omit<E, "id" | "at"> & { id?: string; at?: number }
    : never
  : never;
