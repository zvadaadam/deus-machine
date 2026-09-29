import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { ProjectFilePane, type ProjectFileSelection } from "@/features/projects/ui/ProjectFilePane";

const state = vi.hoisted(() => ({ preview: vi.fn(), readFile: vi.fn() }));
vi.mock("@/features/projects/api/projects.queries", () => ({
  useProjectFile: (...args: unknown[]) => {
    state.readFile(...args);
    return { data: { content: "[Brief](../brief.md)", revision: 7 } };
  },
  useProjectAction: () => ({ isPending: false }),
}));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useMutation: () => ({ isPending: false }),
}));
vi.mock("@/features/file-browser/ui/FilePreview", () => ({
  FilePreview: (props: { actions?: import("react").ReactNode }) => {
    state.preview(props);
    return props.actions;
  },
}));

beforeEach(() => vi.clearAllMocks());

it("keeps document navigation pinned to its selected revision and known files", () => {
  const onOpenFile = vi.fn();
  const file: ProjectFileSelection = {
    path: "docs/plan.md",
    revision: 7,
    editable: true,
    availablePaths: ["docs/plan.md", "brief.md", "results/assignment/proof.md"],
  };
  renderToStaticMarkup(
    createElement(ProjectFilePane, {
      projectId: "project",
      file,
      onClose: vi.fn(),
      onOpenFile,
    })
  );
  expect(state.readFile).toHaveBeenCalledExactlyOnceWith("project", "docs/plan.md", 7);
  const markdown = state.preview.mock.calls.at(-1)![0].markdownLinks;
  markdown.onFileLinkOpen("brief.md");
  expect(onOpenFile).toHaveBeenLastCalledWith({ ...file, path: "brief.md" });
  markdown.onFileLinkOpen("results/assignment/proof.md");
  expect(onOpenFile).toHaveBeenLastCalledWith({
    ...file,
    path: "results/assignment/proof.md",
  });

  const result = onOpenFile.mock.calls.at(-1)![0];
  const resultHtml = renderToStaticMarkup(
    createElement(ProjectFilePane, {
      projectId: "project",
      file: result,
      onClose: vi.fn(),
      onOpenFile,
    })
  );
  expect(resultHtml).not.toContain("Edit file");
  state.preview.mock.calls.at(-1)![0].markdownLinks.onFileLinkOpen("brief.md");
  const contextHtml = renderToStaticMarkup(
    createElement(ProjectFilePane, {
      projectId: "project",
      file: onOpenFile.mock.calls.at(-1)![0],
      onClose: vi.fn(),
      onOpenFile,
    })
  );
  expect(contextHtml).toContain("Edit file");
});
