import { afterEach, beforeEach, expect, it, type Mock, vi } from "vitest";

const capabilities = vi.hoisted(() => ({ ipcInvoke: false }));
vi.mock("@/platform/capabilities", () => ({ capabilities }));
vi.mock("@/platform/electron/invoke", () => ({ invoke: vi.fn() }));

import { openExternalPending } from "@/platform/native/window";

const INSTALL_URL = "https://cloud.deus.test/slack/install?token=abc";

function blankTab() {
  return {
    opener: {} as unknown,
    closed: false,
    close: vi.fn(),
    location: { replace: vi.fn() },
  };
}

let open: Mock;
let assign: Mock;

beforeEach(() => {
  capabilities.ipcInvoke = false;
  open = vi.fn();
  assign = vi.fn();
  vi.stubGlobal("window", { open, location: { assign } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("opens the browser tab during the click, before the URL exists", () => {
  const tab = blankTab();
  open.mockReturnValue(tab);

  openExternalPending();

  expect(open).toHaveBeenCalledWith("about:blank", "_blank");
  // What the tab loads must not reach back into this window.
  expect(tab.opener).toBeNull();
});

it("sends the reserved tab to the URL once it arrives", async () => {
  const tab = blankTab();
  open.mockReturnValue(tab);

  await openExternalPending().open(INSTALL_URL);

  expect(tab.location.replace).toHaveBeenCalledWith(INSTALL_URL);
  expect(assign).not.toHaveBeenCalled();
});

it("closes the reserved tab when the URL never comes", () => {
  const tab = blankTab();
  open.mockReturnValue(tab);

  openExternalPending().cancel();

  expect(tab.close).toHaveBeenCalled();
});

it("goes there in this window when the browser blocked even the immediate tab", async () => {
  open.mockReturnValue(null);

  await openExternalPending().open(INSTALL_URL);

  expect(assign).toHaveBeenCalledWith(INSTALL_URL);
});

it("leaves this window alone when the person closed the reserved tab", async () => {
  const tab = { ...blankTab(), closed: true };
  open.mockReturnValue(tab);

  await openExternalPending().open(INSTALL_URL);

  expect(tab.location.replace).not.toHaveBeenCalled();
  expect(assign).not.toHaveBeenCalled();
});

it("never navigates to a URL that isn't http(s), and closes the tab", async () => {
  const tab = blankTab();
  open.mockReturnValue(tab);

  await openExternalPending().open("javascript:alert(1)");

  expect(tab.location.replace).not.toHaveBeenCalled();
  expect(assign).not.toHaveBeenCalled();
  expect(tab.close).toHaveBeenCalled();
});

it("reserves no tab in the desktop app, which opens the URL in the system browser", async () => {
  const openExternal = vi.fn(async () => {});
  vi.stubGlobal("window", { open, location: { assign }, electronAPI: { openExternal } });

  const pending = openExternalPending();
  expect(open).not.toHaveBeenCalled();
  await pending.open(INSTALL_URL);

  expect(openExternal).toHaveBeenCalledWith(INSTALL_URL);
});
