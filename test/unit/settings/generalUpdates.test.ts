import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { GeneralSection } from "@/features/settings/ui/sections/GeneralSection";
import { UpdateProvider } from "@/features/updates";

vi.mock("@/platform", () => ({ capabilities: { autoUpdate: true } }));
afterEach(() => vi.unstubAllGlobals());

it("shows a retry message and keeps the updater's error in the tooltip", () => {
  vi.stubGlobal("__APP_VERSION__", "test");
  const error = "net::ERR_INTERNET_DISCONNECTED";
  const html = renderToStaticMarkup(
    createElement(UpdateProvider, {
      value: { state: { stage: "error", error }, check: vi.fn(), install: vi.fn() },
      children: createElement(GeneralSection, {
        settings: {},
        theme: "system",
        setTheme: vi.fn(),
        saveSetting: async () => true,
      }),
    })
  );
  expect(html).toContain("Deus will try again.");
  expect(html).toContain(`title="${error}"`);
  expect(html).not.toContain(`>${error}<`);
});
