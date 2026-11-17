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
