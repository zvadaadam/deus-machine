import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { ProjectMarkdown } from "@/features/projects/ui/ProjectMarkdown";

vi.mock("@/platform", () => ({ native: { window: { openExternal: vi.fn() } } }));

it("renders unavailable and sanitized-empty targets as disabled text rather than app navigation", () => {
  const html = renderToStaticMarkup(
    createElement(ProjectMarkdown, {
      sourcePath: "results/assignment/report.md",
      availablePaths: ["results/assignment/proof.md"],
      onOpenFile: vi.fn(),
      children:
        "[Missing](missing.md) [Placeholder]() [Unsafe](javascript:alert%281%29) [Proof](proof.md)",
    })
  );
  expect(html.match(/aria-disabled="true"/g)).toHaveLength(3);
  expect(html).not.toContain('href=""');
  expect(html).toContain('href="results/assignment/proof.md"');
});
