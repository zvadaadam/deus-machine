import type { AccessibilityNode } from "./types.js";
import type { SimBridgeCallOptions } from "./simbridge.js";
import { fetchAccessibilityTree } from "./accessibility.js";
import { findInTree } from "./snapshot/filter.js";

export interface WaitForOptions extends SimBridgeCallOptions {
  timeoutMs?: number;
  intervalMs?: number;
  waitForRemoval?: boolean;
}

export interface WaitForResult {
  found: boolean;
  element?: AccessibilityNode;
  elapsedMs: number;
  attempts: number;
}

export type WaitForPredicate = (node: AccessibilityNode) => boolean;

export async function waitFor(
  udid: string,
  predicate: WaitForPredicate,
  options?: WaitForOptions
): Promise<WaitForResult> {
  const timeoutMs = options?.timeoutMs ?? 10_000;
  const intervalMs = options?.intervalMs ?? 500;
  const waitForRemoval = options?.waitForRemoval ?? false;
  const start = performance.now();
  let attempts = 0;

  for (;;) {
    attempts++;

    let tree: AccessibilityNode[] | null = null;
    try {
      tree = await fetchAccessibilityTree(udid, options);
    } catch {
      // Transient simbridge failure — treat as "not found" and retry
    }

    if (tree) {
      const match = findInTree(tree, predicate);
      if (waitForRemoval ? !match : match) {
        return {
          found: true,
          element: match ?? undefined,
          elapsedMs: Math.round(performance.now() - start),
          attempts,
        };
      }
    }

    const elapsed = performance.now() - start;
    if (elapsed + intervalMs > timeoutMs) {
      return { found: false, elapsedMs: Math.round(elapsed), attempts };
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export async function waitForLabel(
  udid: string,
  label: string,
  options?: WaitForOptions
): Promise<WaitForResult> {
  return waitFor(udid, (n) => n.label === label, options);
}

export async function waitForId(
  udid: string,
  identifier: string,
  options?: WaitForOptions
): Promise<WaitForResult> {
  return waitFor(udid, (n) => n.identifier === identifier, options);
}

export async function waitForType(
  udid: string,
  type: string,
  options?: WaitForOptions
): Promise<WaitForResult> {
  return waitFor(udid, (n) => n.type === type, options);
}
