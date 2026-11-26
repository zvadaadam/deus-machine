export function isTextFieldFocused(): boolean {
  const el = document.activeElement;
  return (
    el instanceof HTMLElement &&
    (el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      el.isContentEditable ||
      el.getAttribute("role") === "textbox")
  );
}
