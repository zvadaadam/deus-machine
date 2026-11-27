import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { postFileWorkspace } from "@shared/boards";
import { BoardFileChip } from "@/features/board/BoardFileChip";

it("opens a post's file in its subject workspace or the board's workspace", () => {
  const board = { workspace_id: "coordinator" };
  expect(postFileWorkspace({ about_workspace_id: "worker" }, board)).toBe("worker");
  expect(postFileWorkspace({ about_workspace_id: null }, board)).toBe("coordinator");
});

it("renders a workspace file action as a button without a browser URL", () => {
  const chip = renderToStaticMarkup(
    createElement(BoardFileChip, {
      link: { path: ".context/report.md" },
      onOpen: () => {},
    })
  );
  expect(chip).toMatch(/<button\b[^>]*type="button"/);
  expect(chip).not.toMatch(/<(?:a\b|button\b[^>]*\shref=)/);
});
