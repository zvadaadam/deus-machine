import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { postFileWorkspace } from "@shared/boards";
import { BoardMarkdown } from "@/features/board/BoardMarkdown";
import { SessionProvider } from "@/features/session/context";
import { TextBlock } from "@/features/session/ui/blocks/TextBlock";

vi.mock("@/features/file-browser/lib/pierreIcons", () => ({ PierreFileIcon: () => null }));

it("board: opens a post's file in its subject workspace or the board's workspace", () => {
  const board = { workspace_id: "coordinator" };
  expect(postFileWorkspace({ about_workspace_id: "worker" }, board)).toBe("worker");
  expect(postFileWorkspace({ about_workspace_id: null }, board)).toBe("coordinator");
});

function renderPost(children: string) {
  return renderToStaticMarkup(createElement(BoardMarkdown, { workspaceId: "worker", children }));
}

it("chat: an extensionless link keeps its existing anchor", () => {
  const chat = renderToStaticMarkup(
    createElement(SessionProvider, {
      sessionId: "chat",
      sessionStatus: "idle",
      workspaceId: "worker",
      subagentMessages: new Map(),
      children: createElement(TextBlock, { block: "[License](LICENSE)" }),
    })
  );
  expect(chat).toMatch(/<a\b[^>]*href="LICENSE"[^>]*>License<\/a>/);
});

it.each([
  ["LICENSE", "LICENSE"],
  [".context/report.md", ".context/report.md"],
  ["file:/x", "/x"],
  ["file:///x", "/x"],
  ["/checkout/report.md", "/checkout/report.md"],
  ["../x", null],
  ["file://server/x", null],
  ["//server/x", null],
  ["ftp://example.org/report.md", null],
  ["javascript:alert(1)", null],
  ["JaVaScRiPt:alert(1)", null],
  [" javascript:alert(1)", null],
  ["\tjavascript:alert(1)", null],
  ["data:text/html,x", null],
  ["vbscript:x", null],
  ["blob:x", null],
  ["#section", null],
  ["", null],
] as const)("board: %s is a file button without a browser URL", (href, path) => {
  const chip = renderPost(`[Read](${href})`);
  expect(chip).toMatch(/<button\b[^>]*type="button"/);
  expect(chip).not.toMatch(/<a\b|\shref\s*=/i);
  expect(chip.includes(' disabled=""')).toBe(path === null);
  if (path) expect(chip).toContain(`title="Open ${path}"`);
});

it("board: an image source still uses the default Markdown URL filter", () => {
  const image = renderPost("![Preview](javascript:alert(1))");
  expect(image).toMatch(/<img\b[^>]*alt="Preview"/);
  expect(image).not.toContain("javascript:");
});

it.each([
  "http://example.org/report.md",
  "https://example.org",
  "mailto:reader@example.org",
  "tel:+12345",
])("board: %s stays an external link", (href) => {
  expect(renderPost(`[Read](${href})`)).toContain(
    `<a href="${href}" target="_blank" rel="noopener noreferrer">Read</a>`
  );
});
