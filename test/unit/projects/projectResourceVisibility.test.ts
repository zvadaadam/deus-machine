import { beforeEach, expect, it, vi } from "vitest";
import { isTabVisible } from "@/app/layouts/content-tabs";
import { openWorkspaceResource } from "@/features/session/lib/openWorkspaceResource";
import type { Settings } from "@shared/types/settings";

const state = vi.hoisted(() => ({
  nativeBrowser: true,
  openContentTab: vi.fn(),
  openFileInContent: vi.fn(),
  requestNewTab: vi.fn(),
  openExternal: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/platform/capabilities", () => ({ capabilities: state }));
vi.mock("@/shared/config/webDirectMode", () => ({ isCloudDirectWebMode: () => false }));
vi.mock("@/features/workspace/store/workspaceLayoutStore", () => ({
  workspaceLayoutActions: state,
}));
vi.mock("@/features/browser/store/browserWindowStore", () => ({ browserWindowActions: state }));
vi.mock("@/platform", () => ({ native: { window: { openExternal: state.openExternal } } }));
vi.mock("sonner", () => ({ toast: { error: state.error } }));

beforeEach(() => {
  vi.clearAllMocks();
  state.nativeBrowser = true;
  state.openExternal.mockResolvedValue(undefined);
});

it.each([
  [true, true, true],
  [false, true, false],
  [true, false, false],
])(
  "browser capability %s and setting %s reveal workspace: %s",
  (nativeBrowser, enabled, expectedReveal) => {
    state.nativeBrowser = nativeBrowser;
    const settings = { experimental_browser: enabled } as Settings;
    const reveal = openWorkspaceResource(
      "workspace",
      { kind: "url", url: "https://example.com/preview" },
      isTabVisible("browser", settings)
    );
    expect(reveal).toBe(expectedReveal);
    if (expectedReveal) {
      expect(state.openContentTab).toHaveBeenCalledExactlyOnceWith("workspace", "browser");
      expect(state.requestNewTab).toHaveBeenCalledExactlyOnceWith(
        "workspace",
        "https://example.com/preview"
      );
      expect(state.openExternal).not.toHaveBeenCalled();
    } else {
      expect(state.openExternal).toHaveBeenCalledExactlyOnceWith("https://example.com/preview");
      expect(state.openContentTab).not.toHaveBeenCalled();
      expect(state.requestNewTab).not.toHaveBeenCalled();
    }
  }
);

it("reveals a file independently of browser availability", () => {
  expect(
    openWorkspaceResource("workspace", { kind: "file", path: "app.ts", target: "files" }, false)
  ).toBe(true);
  expect(state.openFileInContent).toHaveBeenCalledExactlyOnceWith("workspace", "app.ts", "files");
  expect(state.openExternal).not.toHaveBeenCalled();
});

it("surfaces a failed external open and never reveals an unrelated workspace pane", async () => {
  state.openExternal.mockRejectedValueOnce(new Error("Browser could not open"));
  expect(
    openWorkspaceResource("workspace", { kind: "url", url: "https://example.com" }, false)
  ).toBe(false);
  await Promise.resolve();
  expect(state.error).toHaveBeenCalledExactlyOnceWith("Browser could not open");
  expect(state.openContentTab).not.toHaveBeenCalled();
  expect(state.requestNewTab).not.toHaveBeenCalled();
});
