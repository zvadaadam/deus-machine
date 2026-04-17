/**
 * device-use SDK — programmatic iOS Simulator automation.
 *
 * @example
 * ```ts
 * import { session } from 'device-use'
 *
 * await session('iPhone 17 Pro')
 *   .app('Maps')
 *   .snapshot()
 *   .tapOn('@e1')
 *   .inputText('Coffee')
 *   .run()
 * ```
 */

import { Session } from "./builder.js";

export { Session };
export type { RunContext, StepLog } from "./builder.js";
export { resolveBundleId } from "./apps.js";

/** Create a new automation session targeting a simulator by name or UDID. */
export function session(simulator: string): Session {
  return new Session(simulator);
}

export type { AccessibilityNode, RefEntry, Simulator, Frame, Point } from "../engine/types.js";
export type { WaitForOptions, WaitForResult, WaitForPredicate } from "../engine/wait-for.js";
export type { SnapshotDiff, SnapshotDiffEntry } from "../engine/snapshot/diff.js";
