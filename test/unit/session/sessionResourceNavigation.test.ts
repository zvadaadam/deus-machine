import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider, useSession } from "@/features/session/context";
import { TextBlock } from "@/features/session/ui/blocks/TextBlock";

const state = vi.hoisted(() => ({
  markdown: vi.fn(),
  openContentTab: vi.fn(),
  requestNewTab: vi.fn(),
  openFileInContent: vi.fn(),
  openExternal: vi.fn(),
  nativeBrowser: true,
}));
vi.mock("@/components/markdown", () => ({
  ChatMarkdown: (props: unknown) => {
    state.markdown(props);
    return null;
  },
}));
vi.mock("@/features/workspace/store/workspaceLayoutStore", () => ({
  workspaceLayoutActions: state,
}));
vi.mock("@/features/browser/store/browserWindowStore", () => ({ browserWindowActions: state }));
vi.mock("@/platform/capabilities", () => ({ capabilities: state }));
vi.mock("@/platform", () => ({ native: { window: { openExternal: state.openExternal } } }));
vi.mock("@/shared/config/api.config", () => ({
  getBaseURL: async () => "http://backend:4000/api",
}));

beforeEach(() => {
  vi.clearAllMocks();
  state.nativeBrowser = true;
  state.openExternal.mockResolvedValue(undefined);
});

function NestedConversation() {
  const { openResource } = useSession();
  return createElement(SessionProvider, {
    workspaceId: "workspace",
    sessionStatus: "idle",
    subagentMessages: new Map(),
    onOpenResource: openResource,
    children: createElement(TextBlock, { block: "[Preview](index.html)", role: "assistant" }),
  });
}

function render(
  onOpenResource?: (resource: unknown) => void,
  nested = false,
  browserAvailable?: boolean
) {
  renderToStaticMarkup(
    createElement(SessionProvider, {
      workspaceId: "workspace",
      workspacePath: "/repo/workspace",
      sessionStatus: "idle",
      subagentMessages: new Map(),
      onOpenResource,
      browserAvailable,
      children: nested
        ? createElement(NestedConversation)
        : createElement(TextBlock, { block: "[Preview](index.html)", role: "assistant" }),
    })
  );
  return state.markdown.mock.calls.at(-1)![0];
}

describe("session resource host navigation", () => {
  it("retains ordinary workspace file and browser navigation", async () => {
    const markdown = render();
    await markdown.onFileLinkOpen("src/app.ts");
    expect(state.openFileInContent).toHaveBeenCalledExactlyOnceWith(
      "workspace",
      "src/app.ts",
      "files"
    );
    await markdown.onLinkOpen("http://localhost:5173");
    expect(state.openContentTab).toHaveBeenCalledExactlyOnceWith("workspace", "browser");
    expect(state.requestNewTab).toHaveBeenCalledExactlyOnceWith(
      "workspace",
      "http://localhost:5173"
    );
  });

  it.each([false, true])(
    "lets the embedded host open resources before changing panes (nested: %s)",
    async (nested) => {
      const host = vi.fn();
      const markdown = render(host, nested);
      await markdown.onFileLinkOpen("src/app.ts");
      expect(host).toHaveBeenLastCalledWith({ kind: "file", path: "src/app.ts", target: "files" });
      await markdown.onFileLinkOpen("index.html");
      expect(host).toHaveBeenLastCalledWith({
        kind: "url",
        url: "http://backend:4000/api/workspaces/workspace/file-preview?path=index.html",
      });
      await markdown.onLinkOpen("https://example.com");
      expect(host).toHaveBeenLastCalledWith({ kind: "url", url: "https://example.com" });
      expect(state.openFileInContent).not.toHaveBeenCalled();
      expect(state.openContentTab).not.toHaveBeenCalled();
      expect(state.requestNewTab).not.toHaveBeenCalled();
    }
  );

  it("opens ordinary connected-web links externally without selecting a hidden browser pane", async () => {
    state.nativeBrowser = false;
    const markdown = render();
    await markdown.onLinkOpen("http://localhost:5173");
    expect(state.openExternal).toHaveBeenCalledExactlyOnceWith("http://localhost:5173");
    expect(state.openContentTab).not.toHaveBeenCalled();
    expect(state.requestNewTab).not.toHaveBeenCalled();
  });

  it("honors the normal session host's disabled Browser setting", async () => {
    const markdown = render(undefined, false, false);
    await markdown.onLinkOpen("http://localhost:5173");
    expect(state.openExternal).toHaveBeenCalledExactlyOnceWith("http://localhost:5173");
    expect(state.openContentTab).not.toHaveBeenCalled();
    expect(state.requestNewTab).not.toHaveBeenCalled();
  });
});
