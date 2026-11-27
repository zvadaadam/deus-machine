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

function postLink(href: string) {
  return renderToStaticMarkup(
    createElement(BoardMarkdown, { workspaceId: "worker", children: `[Read](${href})` })
  );
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
  ["#section", null],
  ["", null],
] as const)("board: %s is a file button without a browser URL", (href, path) => {
  const chip = postLink(href);
  expect(chip).toMatch(/<button\b[^>]*type="button"/);
  expect(chip).not.toMatch(/<(?:a\b|button\b[^>]*\shref=)/);
  expect(chip.includes(' disabled=""')).toBe(path === null);
  if (path) expect(chip).toContain(`title="Open ${path}"`);
});

it.each([
  "http://example.org/report.md",
  "https://example.org",
  "mailto:reader@example.org",
  "tel:+12345",
])("board: %s stays an external link", (href) => {
  expect(postLink(href)).toContain(`<a href="${href}">Read</a>`);
});
