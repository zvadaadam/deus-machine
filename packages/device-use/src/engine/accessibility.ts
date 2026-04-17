import type { AccessibilityNode, SimBridgeResponse } from "./types.js";
import { callSimBridge, type SimBridgeCallOptions } from "./simbridge.js";

/** Fetch the accessibility tree from a booted simulator via simbridge. */
export async function fetchAccessibilityTree(
  udid: string,
  options?: SimBridgeCallOptions
): Promise<AccessibilityNode[]> {
  const response: SimBridgeResponse = await callSimBridge(
    { command: "describe-ui", udid },
    options
  );

  return (response.data as { elements?: AccessibilityNode[] } | undefined)?.elements ?? [];
}
