import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveProjectFileLink } from "@/features/projects/lib/projectFileLinks";
import { ProjectMarkdown } from "@/features/projects/ui/ProjectMarkdown";

const state = vi.hoisted(() => ({ markdown: vi.fn(), openExternal: vi.fn() }));
vi.mock("@/components/markdown/MarkdownRenderer", () => ({
  MarkdownRenderer: (props: unknown) => {
    state.markdown(props);
    return null;
  },
}));
vi.mock("@/platform", () => ({ native: { window: { openExternal: state.openExternal } } }));

const paths = [
  "brief.md",
  "docs/plan.md",
  "results/assignment/summary.md",
  "results/assignment/proof.txt",
];

describe("published Project file links", () => {
  it.each([
    ["./proof.txt", "results/assignment/summary.md", "results/assignment/proof.txt"],
    [
      "results/assignment/proof.txt",
      "results/assignment/report.md",
      "results/assignment/proof.txt",
    ],
    ["../brief.md", "docs/plan.md", "brief.md"],
    ["/docs/plan.md#notes", "brief.md", "docs/plan.md"],
    ["./%70lan.md?view=raw", "docs/other.md", "docs/plan.md"],
  ])("resolves %s from %s", (href, source, expected) => {
    expect(resolveProjectFileLink(href, source, paths)).toMatchObject({ path: expected });
  });

  it.each([
    "missing.md",
    "../../../brief.md",
    "%2e%2e/%2e%2e/brief.md",
    "%00brief.md",
    "bad%zz",
    "..\\brief.md",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "",
  ])("disables unavailable or invalid links: %s", (href) =>
    expect(resolveProjectFileLink(href, "docs/plan.md", paths)).toMatchObject({ disabled: true })
  );

  it("does not treat web links as Project files", () => {
    expect(resolveProjectFileLink("https://example.com/brief.md", "brief.md", paths)).toBeNull();
    expect(resolveProjectFileLink("//example.com/brief.md", "brief.md", paths)).toBeNull();
  });
});

describe("Project markdown navigation", () => {
  beforeEach(() => {
    state.markdown.mockClear();
    state.openExternal.mockReset().mockResolvedValue(undefined);
  });

  it("opens external URLs through the platform and leaves file selection with the pinned host", async () => {
    const onOpenFile = vi.fn();
    renderToStaticMarkup(
      createElement(ProjectMarkdown, {
        children: "[Proof](proof.txt) [PR](https://github.com/example/repo/pull/1)",
        sourcePath: "results/assignment/summary.md",
        availablePaths: paths,
        onOpenFile,
      })
    );
    const props = state.markdown.mock.calls.at(-1)![0];
    const link = props.resolveFileLink("proof.txt");
    props.onFileLinkOpen(link.path);
    expect(onOpenFile).toHaveBeenCalledExactlyOnceWith("results/assignment/proof.txt");
    await props.onLinkOpen("https://github.com/example/repo/pull/1");
    expect(state.openExternal).toHaveBeenCalledExactlyOnceWith(
      "https://github.com/example/repo/pull/1"
    );
    await props.onLinkOpen("//example.com/result");
    expect(state.openExternal).toHaveBeenLastCalledWith("https://example.com/result");
  });
});
