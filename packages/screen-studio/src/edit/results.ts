import type { Rect } from "../bundle/schema.js";
import type { MotionAnalysis } from "./motion.js";
import type { Timeline } from "./timeline.js";

/** A visible outcome of an action: the picture changed after a still wait. */
export interface ActionResult {
  /** Source time the picture changed. */
  atMs: number;
  actionId: string;
  /** How long after the action completed the result appeared. */
  delayMs: number;
  /** Where the picture changed, once measured (`measureChanges`). */
  region?: Rect | null;
  /** Share of the screen that changed; near 1 is a new page. */
  share?: number;
}

const MIN_DELAY_MS = 300;
const MAX_DELAY_MS = 30_000;

/**
 * Link each change in the picture to the action it answers: the latest action
 * completed before it, if the change came 0.3–30 s later.
 * Changes right after an action are its own effect (already in its reading
 * margin); changes with no recent action are someone else's (ignored).
 */
export function findResults(timeline: Timeline, motion: MotionAnalysis | null): ActionResult[] {
  if (!motion?.changes?.length) return [];
  const results: ActionResult[] = [];
  for (const change of motion.changes) {
    // Every change ends a still stretch; the action's own small effects (a
    // border, typed text) often don't register as motion, so the stretch may
    // begin before it. What matters is that nothing else happened in between.
    const action = [...timeline.actions].reverse().find((a) => a.endMs <= change.atMs);
    if (!action) continue;
    const delayMs = change.atMs - action.endMs;
    if (delayMs < MIN_DELAY_MS || delayMs > MAX_DELAY_MS) continue;
    results.push({ atMs: change.atMs, actionId: action.id, delayMs });
  }
  return results;
}
