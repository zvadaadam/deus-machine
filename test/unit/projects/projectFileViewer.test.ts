import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { FileViewer } from "@/features/file-browser/ui/FileViewer";

const state = vi.hoisted(() => ({ markdown: vi.fn() }));
vi.mock("@/app/providers", () => ({ useTheme: () => ({ actualTheme: "light" }) }));
vi.mock("@/features/file-browser/api/useFileContent", () => ({
  useFileContent: () => ({ data: "[Guide](../guide.md) [Website](https://example.com)" }),
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: [], isLoading: false }) }));
vi.mock("@/features/file-browser/lib/pierreIcons", () => ({ PierreFileIcon: () => null }));
vi.mock("@/components/markdown/MarkdownRenderer", () => ({
  MarkdownRenderer: (props: unknown) => {
    state.markdown(props);
    return null;
  },
}));

beforeEach(() => vi.clearAllMocks());

it("routes nested mobile document links through its host without escaping the workspace", () => {
  const host = vi.fn();
  renderToStaticMarkup(
    createElement(FileViewer, {
      workspaceId: "workspace",
      filePath: "docs/README.md",
      onOpenResource: host,
    })
  );
  const markdown = state.markdown.mock.calls.at(-1)![0];
  const guide = markdown.resolveFileLink("../guide.md");
  markdown.onFileLinkOpen(guide.path);
  expect(host).toHaveBeenLastCalledWith({ kind: "file", path: "guide.md", target: "files" });
  expect(markdown.resolveFileLink("../../outside.md")).toMatchObject({ disabled: true });
  markdown.onLinkOpen("https://example.com");
  expect(host).toHaveBeenLastCalledWith({ kind: "url", url: "https://example.com" });
});

it("preserves ordinary FileViewer link behavior when no embedding host is supplied", () => {
  renderToStaticMarkup(
    createElement(FileViewer, { workspaceId: "workspace", filePath: "README.md" })
  );
  const markdown = state.markdown.mock.calls.at(-1)![0];
  expect(markdown.resolveFileLink).toBeUndefined();
  expect(markdown.onFileLinkOpen).toBeUndefined();
  expect(markdown.onLinkOpen).toBeUndefined();
});
