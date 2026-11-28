import { cubicBezier } from "framer-motion";
import { tempo } from "./tempo";

const MS_PER_SECOND = 1000;
const BACKSPACE_MS = tempo.moderate.exit.duration * MS_PER_SECOND;
const PAUSE_MS = tempo.step * MS_PER_SECOND;
const TYPE_MS = tempo.slow.duration * MS_PER_SECOND;
const FEATHER_CHARS = 2;

const ease = cubicBezier(...tempo.moderate.ease);

interface TitleTyperChar {
  char: string;
  opacity: number;
}

export interface TitleTyperFrame {
  entityId: string;
  target: string;
  /** Leading text at full opacity. */
  solid: string;
  /** Trailing characters currently peeling away or fading in (0 < opacity < 1). */
  tail: TitleTyperChar[];
  /** Invisible ghost strings reserving max(old, new) width while animating; empty when settled. */
  reserve: string[];
}

export interface TitleTyperClock {
  now: () => number;
  request: (cb: () => void) => number;
  cancel: (id: number) => void;
}

export interface TitleTyper {
  getFrame(): TitleTyperFrame;
  set(entityId: string, text: string, reducedMotion?: boolean): void;
  dispose(): void;
}

interface ActiveRun {
  fromChars: string[];
  toChars: string[];
  prefixLen: number;
  deleteMs: number;
  pauseMs: number;
  typeMs: number;
  startTime: number;
  reserve: string[];
}

const defaultClock: TitleTyperClock = {
  now: () => performance.now(),
  request: (cb) => requestAnimationFrame(cb),
  cancel: (id) => cancelAnimationFrame(id),
};

function sharedPrefixLength(from: readonly string[], to: readonly string[]): number {
  const limit = Math.min(from.length, to.length);
  let common = 0;
  while (common < limit && from[common] === to[common]) common++;
  if (common === from.length || common === to.length) return common;
  for (let i = common - 1; i >= 0; i--) {
    if (from[i] === " ") return i + 1;
  }
  return 0;
}

function reveal(
  chars: readonly string[],
  prefixLen: number,
  amount: number
): Pick<TitleTyperFrame, "solid" | "tail"> {
  const count = chars.length - prefixLen;
  if (count <= 0 || amount <= 0) {
    return { solid: chars.slice(0, prefixLen).join(""), tail: [] };
  }
  if (amount >= 1) {
    return { solid: chars.join(""), tail: [] };
  }

  const feather = Math.min(FEATHER_CHARS, count);
  const front = amount * (count - 1 + feather);
  let solidEnd = prefixLen;
  const tail: TitleTyperChar[] = [];

  for (let i = 0; i < count; i++) {
    const opacity = Math.round(Math.min(1, Math.max(0, (front - i) / feather)) * 100) / 100;
    if (opacity <= 0) break;
    if (opacity >= 1) {
      solidEnd = prefixLen + i + 1;
    } else {
      tail.push({ char: chars[prefixLen + i], opacity });
    }
  }

  return { solid: chars.slice(0, solidEnd).join(""), tail };
}

function restingFrame(entityId: string, text: string): TitleTyperFrame {
  return { entityId, target: text, solid: text, tail: [], reserve: [] };
}

function evaluateRun(run: ActiveRun, entityId: string, now: number): TitleTyperFrame | null {
  const elapsed = Math.max(0, now - run.startTime);
  const pauseEnd = run.deleteMs + run.pauseMs;

  if (elapsed >= pauseEnd + run.typeMs) return null;

  const part =
    elapsed < run.deleteMs
      ? reveal(run.fromChars, run.prefixLen, ease(1 - elapsed / run.deleteMs))
      : elapsed < pauseEnd
        ? { solid: run.fromChars.slice(0, run.prefixLen).join(""), tail: [] }
        : reveal(run.toChars, run.prefixLen, ease((elapsed - pauseEnd) / run.typeMs));

  return { entityId, target: run.toChars.join(""), ...part, reserve: run.reserve };
}

export function createTitleTyper(
  initial: { entityId: string; text: string },
  onFrame: (frame: TitleTyperFrame) => void,
  clock: TitleTyperClock = defaultClock
): TitleTyper {
  let frame = restingFrame(initial.entityId, initial.text);
  let activeRun: ActiveRun | null = null;
  let rafId: number | null = null;
  let disposed = false;

  function cancelScheduled() {
    if (rafId !== null) {
      clock.cancel(rafId);
      rafId = null;
    }
  }

  function emit(next: TitleTyperFrame) {
    frame = next;
    onFrame(frame);
  }

  function schedule() {
    if (disposed || rafId !== null) return;
    rafId = clock.request(() => {
      rafId = null;
      if (disposed || !activeRun) return;
      const next = evaluateRun(activeRun, frame.entityId, clock.now());
      if (!next) {
        const toText = activeRun.toChars.join("");
        activeRun = null;
        emit(restingFrame(frame.entityId, toText));
        return;
      }
      emit(next);
      schedule();
    });
  }

  return {
    getFrame: () => frame,

    set(entityId: string, text: string, reducedMotion = false) {
      if (disposed) return;

      if (entityId !== frame.entityId || reducedMotion) {
        cancelScheduled();
        activeRun = null;
        if (frame.entityId !== entityId || frame.target !== text || frame.reserve.length > 0) {
          emit(restingFrame(entityId, text));
        }
        return;
      }

      if (text === frame.target) return;

      cancelScheduled();

      // Restart from `frame.solid` so partly faded tail characters don't flash back to full opacity.
      const fromText = frame.solid;
      const fromChars = Array.from(fromText);
      const toChars = Array.from(text);
      const prefixLen = sharedPrefixLength(fromChars, toChars);
      const hasDelete = fromChars.length > prefixLen;
      const hasType = toChars.length > prefixLen;

      if (!hasDelete && !hasType) {
        activeRun = null;
        emit(restingFrame(entityId, text));
        return;
      }

      const reserve = [fromText, text].filter((s, i, arr) => s.length > 0 && arr.indexOf(s) === i);
      activeRun = {
        fromChars,
        toChars,
        prefixLen,
        deleteMs: hasDelete ? BACKSPACE_MS : 0,
        pauseMs: hasDelete && hasType ? PAUSE_MS : 0,
        typeMs: hasType ? TYPE_MS : 0,
        startTime: clock.now(),
        reserve,
      };

      emit({ entityId, target: text, solid: fromText, tail: [], reserve });
      schedule();
    },

    dispose() {
      disposed = true;
      activeRun = null;
      cancelScheduled();
    },
  };
}
