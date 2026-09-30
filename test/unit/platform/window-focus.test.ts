import { afterEach, beforeEach, expect, it, vi } from "vitest";

const capabilities = vi.hoisted(() => ({ nativeWindowChrome: false }));
vi.mock("@/platform/capabilities", () => ({ capabilities }));
vi.mock("@/platform/electron/invoke", () => ({ invoke: vi.fn() }));

import { onFocus } from "@/platform/native/window";

let win: EventTarget;
let doc: EventTarget & { hidden: boolean };

beforeEach(() => {
  win = new EventTarget();
  doc = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("desktop: the window regaining focus counts, though the page never became hidden", () => {
  capabilities.nativeWindowChrome = true;
  const listener = vi.fn();

  const stop = onFocus(listener);
  win.dispatchEvent(new Event("blur"));
  win.dispatchEvent(new Event("focus"));
  expect(listener).toHaveBeenCalledTimes(1);

  stop();
  win.dispatchEvent(new Event("focus"));
  expect(listener).toHaveBeenCalledTimes(1);
});

it("browser: the tab coming back into view counts, leaving it does not", () => {
  capabilities.nativeWindowChrome = false;
  const listener = vi.fn();

  const stop = onFocus(listener);
  doc.hidden = true;
  doc.dispatchEvent(new Event("visibilitychange"));
  expect(listener).not.toHaveBeenCalled();
  doc.hidden = false;
  doc.dispatchEvent(new Event("visibilitychange"));
  expect(listener).toHaveBeenCalledTimes(1);

  stop();
  doc.dispatchEvent(new Event("visibilitychange"));
  expect(listener).toHaveBeenCalledTimes(1);
});
