import type { EventInput, Manifest, SourceKind } from "../bundle/schema.js";
import type { Size } from "../util/units.js";

export interface CaptureContext {
  /** Absolute path of the bundle's media directory. */
  mediaDir: string;
  fps: number;
  log: (message: string) => void;
  /** The source went away (tab closed, simulator shut down). The recorder stops. */
  onSourceLost: (reason: string) => void;
  /** The source's viewport changed size mid-capture. */
  onGeometry: (viewport: Size) => void;
  /** The capture process died. The recorder finalizes whatever was written. */
  onFailure: (error: Error) => void;
  /** Evidence the source observed itself: input in a browser tab, spans it was not painted. */
  onEvent?: (event: EventInput) => void;
}

export interface FinalizedCapture {
  /** Absolute path of the finalized media file. */
  path: string;
  warnings: string[];
}

export interface ActiveCapture {
  /** Epoch ms of media time zero. */
  mediaStartEpochMs: number;
  /** Bound on how far media zero may be from when that frame was on screen. */
  uncertaintyMs: number;
  clockMethod: string;
  /** Known once frames arrive; otherwise filled from the finalized media. */
  geometry?: { viewport: Size; media: Size };
  pointerInPixels: NonNullable<Manifest["media"]>["pointerInPixels"];
  /** Helper processes that must be stopped if this owner dies. */
  childPids: number[];
  /** Frames written so far, when the backend can count them. Bytes are measured on disk. */
  stats(): { frames: number | null };
  /** Stop capturing and finalize the media. Called at most once. */
  stop(): Promise<FinalizedCapture>;
}

/** A resolved, startable source. */
export interface CaptureBackend {
  /** Canonical source ID, stable enough to record in the manifest. */
  id: string;
  kind: SourceKind;
  backend: string;
  label: string;
  details: Record<string, unknown>;
  start(context: CaptureContext): Promise<ActiveCapture>;
}
