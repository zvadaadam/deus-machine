import { callSimBridge, type SimBridgeCallOptions } from "./simbridge.js";
import { fetchAccessibilityTree } from "./accessibility.js";
import { SimBridgeError } from "./errors.js";
import type { AccessibilityNode, Point, RefEntry } from "./types.js";
import { filterTree } from "./snapshot/filter.js";

/** HID interaction — touch + keyboard via simbridge. */

/** Squared Euclidean distance — avoids sqrt; only used for relative comparison. */
function dist2(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

async function tapByFind(
  udid: string,
  predicate: (e: AccessibilityNode) => boolean,
  description: string,
  options?: SimBridgeCallOptions,
  hint?: Point
): Promise<void> {
  const tree = await fetchAccessibilityTree(udid, options);
  const matches = filterTree(tree, predicate);
  if (matches.length === 0) {
    throw new SimBridgeError(`Element with ${description} not found`, "ELEMENT_NOT_FOUND");
  }
  // When the ref carries a `center`, disambiguate same-label/identifier collisions
  // by picking the live node closest to where the snapshot originally placed the
  // ref. Without a hint (label/id CLI paths), preserve the first-DFS-match behavior
  // callers have always seen.
  const el =
    matches.length === 1 || !hint
      ? matches[0]
      : matches.reduce((best, n) => (dist2(n.center, hint) < dist2(best.center, hint) ? n : best));
  await callSimBridge({ command: "tap", udid, x: el.center.x, y: el.center.y }, options);
}

export async function tap(
  udid: string,
  x: number,
  y: number,
  options?: SimBridgeCallOptions
): Promise<void> {
  await callSimBridge({ command: "tap", udid, x, y }, options);
}

export async function tapById(
  udid: string,
  identifier: string,
  options?: SimBridgeCallOptions,
  hint?: Point
): Promise<void> {
  await tapByFind(udid, (e) => e.identifier === identifier, `id="${identifier}"`, options, hint);
}

export async function tapByLabel(
  udid: string,
  label: string,
  options?: SimBridgeCallOptions,
  hint?: Point
): Promise<void> {
  await tapByFind(udid, (e) => e.label === label, `label="${label}"`, options, hint);
}

/**
 * Tap a RefEntry using the best available method: identifier > label > coordinates.
 * The ref's `center` is threaded as a disambiguation hint, so when multiple live
 * nodes match by identifier/label the one closest to the snapshot's original
 * placement is tapped — refs that share a label no longer collide onto the
 * first DFS match.
 */
export async function tapEntry(
  udid: string,
  entry: Pick<RefEntry, "identifier" | "label" | "center">,
  options?: SimBridgeCallOptions
): Promise<void> {
  if (entry.identifier) {
    await tapById(udid, entry.identifier, options, entry.center);
  } else if (entry.label) {
    await tapByLabel(udid, entry.label, options, entry.center);
  } else {
    await tap(udid, entry.center.x, entry.center.y, options);
  }
}

export async function typeText(
  udid: string,
  text: string,
  submit?: boolean,
  options?: SimBridgeCallOptions
): Promise<void> {
  await callSimBridge({ command: "type", udid, text, submit: submit ?? false }, options);
}

export async function swipe(
  udid: string,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  duration?: number,
  options?: SimBridgeCallOptions
): Promise<void> {
  await callSimBridge(
    {
      command: "swipe",
      udid,
      startX,
      startY,
      endX,
      endY,
      ...(duration !== undefined && { duration }),
    },
    options
  );
}

export async function pressKey(
  udid: string,
  keyCode: number,
  options?: SimBridgeCallOptions
): Promise<void> {
  await callSimBridge({ command: "key", udid, keyCode }, options);
}

export async function pressButton(
  udid: string,
  button: string,
  options?: SimBridgeCallOptions
): Promise<void> {
  await callSimBridge({ command: "button", udid, button }, options);
}
