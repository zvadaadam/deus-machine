import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { ProjectDetail } from "@shared/projects";
import { ProjectFilesView } from "@/features/projects/ui/ProjectFilesView";
import type { ProjectFilePane } from "@/features/projects/ui/ProjectFilePane";
import type { FileTree } from "@/features/file-browser/ui/components/FileTree";
import { buildProjectFileTree } from "@/features/projects/lib/projectFileTree";

const state = vi.hoisted(() => ({ tree: vi.fn(), pane: vi.fn() }));
vi.mock("@/features/file-browser/ui/components/FileTree", () => ({
  FileTree: (props: ComponentProps<typeof FileTree>) => {
    state.tree(props);
    return null;
  },
}));
vi.mock("@/features/projects/ui/ProjectFilePane", () => ({
  ProjectFilePane: (props: ComponentProps<typeof ProjectFilePane>) => {
    state.pane(props);
    return null;
  },
}));

const files = ["brief.md", "docs/plan.md", "docs/guides/setup.md", "results/task/proof.md"].map(
  (path) => ({ path, size: 5, hash: "hash" })
);
const project = { id: "project", files, contentRevision: 8, status: "idle" } as ProjectDetail;
beforeEach(() => vi.clearAllMocks());

it("builds shared folder ancestors with stable paths and file metadata", () => {
  expect(buildProjectFileTree(files)).toEqual([
    {
      name: "docs",
      path: "docs",
      type: "directory",
      children: [
        {
          name: "guides",
          path: "docs/guides",
          type: "directory",
          children: [{ name: "setup.md", path: "docs/guides/setup.md", type: "file", size: 5 }],
        },
        { name: "plan.md", path: "docs/plan.md", type: "file", size: 5 },
      ],
    },
    {
      name: "results",
      path: "results",
      type: "directory",
      children: [
        {
          name: "task",
          path: "results/task",
          type: "directory",
          children: [{ name: "proof.md", path: "results/task/proof.md", type: "file", size: 5 }],
        },
      ],
    },
    { name: "brief.md", path: "brief.md", type: "file", size: 5 },
  ]);
});

it("opens tree files at the current content revision without changing a pinned report selection", () => {
  const onSelect = vi.fn();
  const selection = {
    path: "results/task/proof.md",
    revision: 3,
    fromReport: true,
    availablePaths: ["results/task/proof.md"],
  };
  const render = (detail: ProjectDetail) =>
    renderToStaticMarkup(
      createElement(ProjectFilesView, {
        project: detail,
        selection,
        onSelect,
      })
    );
  const html = render(project);
  expect(html).toContain("Back to files");
  expect(state.pane.mock.calls.at(-1)![0].file).toMatchObject(selection);
  render({ ...project, contentRevision: 9 });
  expect(onSelect).not.toHaveBeenCalled();
  expect(state.pane.mock.calls.at(-1)![0].file).toMatchObject(selection);
  state.tree.mock.calls.at(-1)![0].onFileClick("docs/plan.md");
  expect(onSelect).toHaveBeenCalledExactlyOnceWith({
    path: "docs/plan.md",
    revision: 9,
    editable: true,
    availablePaths: files.map((file) => file.path),
  });
});
