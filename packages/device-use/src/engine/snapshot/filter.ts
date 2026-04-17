import type { AccessibilityNode } from "../types.js";

const INTERACTIVE_TYPES = new Set([
  "Button",
  "TextField",
  "SecureTextField",
  "TextArea",
  "Switch",
  "Slider",
  "Stepper",
  "Picker",
  "DatePicker",
  "Toggle",
  "CheckBox",
  "RadioButton",
  "Link",
  "MenuItem",
  "Tab",
  "TabBarButton",
  "SegmentedControl",
  "PopUpButton",
  "Cell",
  "DisclosureTriangle",
  "ComboBox",
  "SearchField",
  "ColorWell",
  "PageIndicator",
]);

export function isInteractive(node: AccessibilityNode): boolean {
  return INTERACTIVE_TYPES.has(node.type) || node.traits.includes("interactive");
}

export function filterTree(
  nodes: AccessibilityNode[],
  predicate: (node: AccessibilityNode) => boolean
): AccessibilityNode[] {
  const result: AccessibilityNode[] = [];
  function walk(list: AccessibilityNode[]): void {
    for (const node of list) {
      if (predicate(node)) result.push(node);
      walk(node.children);
    }
  }
  walk(nodes);
  return result;
}

export function findInTree(
  nodes: AccessibilityNode[],
  predicate: (node: AccessibilityNode) => boolean
): AccessibilityNode | null {
  for (const node of nodes) {
    if (predicate(node)) return node;
    const found = findInTree(node.children, predicate);
    if (found) return found;
  }
  return null;
}

export function filterInteractive(nodes: AccessibilityNode[]): AccessibilityNode[] {
  return filterTree(nodes, (n) => isInteractive(n) && n.enabled);
}
