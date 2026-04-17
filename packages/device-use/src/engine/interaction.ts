import { callSimBridge, type SimBridgeCallOptions } from "./simbridge.js";
import { fetchAccessibilityTree } from "./accessibility.js";
import { SimBridgeError } from "./errors.js";
import type { AccessibilityNode, RefEntry } from "./types.js";
import { findInTree } from "./snapshot/filter.js";

/** HID interaction — touch + keyboard via simbridge. */

async function tapByFind(
  udid: string,
  predicate: (e: AccessibilityNode) => boolean,
  description: string,
  options?: SimBridgeCallOptions
): Promise<void> {
  const tree = await fetchAccessibilityTree(udid, options);
  const el = findInTree(tree, predicate);
  if (!el) throw new SimBridgeError(`Element with ${description} not found`, "ELEMENT_NOT_FOUND");
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
  options?: SimBridgeCallOptions
): Promise<void> {
  await tapByFind(udid, (e) => e.identifier === identifier, `id="${identifier}"`, options);
}

export async function tapByLabel(
  udid: string,
  label: string,
  options?: SimBridgeCallOptions
): Promise<void> {
  await tapByFind(udid, (e) => e.label === label, `label="${label}"`, options);
}

/** Tap a RefEntry using the best available method: identifier > label > coordinates. */
export async function tapEntry(
  udid: string,
  entry: Pick<RefEntry, "identifier" | "label" | "center">,
  options?: SimBridgeCallOptions
): Promise<void> {
  if (entry.identifier) {
    await tapById(udid, entry.identifier, options);
  } else if (entry.label) {
    await tapByLabel(udid, entry.label, options);
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
