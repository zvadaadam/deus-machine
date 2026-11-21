import { Children, createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateCheckResult } from "@shared/types/updates";
import { GeneralSection } from "@/features/settings/ui/sections/GeneralSection";
import { UpdateProvider, useAutoUpdate } from "@/features/updates";

vi.mock("@/platform/capabilities", () => ({ capabilities: { autoUpdate: true } }));
vi.mock("@/platform", () => import("@/platform/capabilities"));
vi.mock("@/shared/stores/uiStore", () => ({ useUIStore: () => vi.fn() }));

// Keep the hook and the section's state across static renders after a click.
const state = new Map<string, unknown>();
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useState(initial: unknown) {
      const id = react.useId();
      const [value] = react.useState(initial);
      if (!state.has(id)) state.set(id, value);
      return [
        state.get(id),
        (next: unknown) => state.set(id, typeof next === "function" ? next(state.get(id)) : next),
      ];
    },
  };
});

let checkNow: () => Promise<void>;
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick }: { children: ReactNode; onClick: () => Promise<void> }) => {
    if (Children.toArray(children).includes("Check now")) checkNow = onClick;
    return createElement("button", null, children);
  },
}));

function General() {
  const section = createElement(GeneralSection, {
    settings: {},
    theme: "system",
    setTheme: vi.fn(),
    saveSetting: async () => true,
  });
  return createElement(UpdateProvider, { value: useAutoUpdate(), children: section });
}

const checkForUpdates = vi.fn<() => Promise<UpdateCheckResult>>();
const render = () => renderToStaticMarkup(createElement(General));

beforeEach(() => {
  state.clear();
  checkForUpdates.mockReset();
  vi.stubGlobal("__APP_VERSION__", "0.3.20");
  vi.stubGlobal("window", { electronAPI: { checkForUpdates } });
});
afterEach(() => vi.unstubAllGlobals());

describe("Check now in Settings", () => {
  it("shows why a Debian install needs the AppImage", async () => {
    const reason = "Linux auto-update requires the AppImage build";
    checkForUpdates.mockResolvedValue({ supported: false, available: false, reason });
    render();
    await checkNow();
    const html = render();
    expect(html).toContain(`>${reason}<`);
    expect(html).not.toContain("Deus will try again.");
    expect(html).not.toContain("Updates download automatically");
    expect(html).not.toContain("on the latest version.");
  });

  it("keeps the retry message for a failed update check and puts the detail on hover", async () => {
    const error = "net::ERR_INTERNET_DISCONNECTED";
    checkForUpdates.mockRejectedValue(new Error(error));
    render();
    await checkNow();
    const html = render();
    expect(html).toContain("Deus will try again.");
    expect(html).toContain(`title="${error}"`);
    expect(html).not.toContain(`>${error}<`);
  });
});
