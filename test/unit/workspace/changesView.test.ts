import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { preloadFileTree } from "@pierre/trees";
import { useFileTree } from "@pierre/trees/react";
import { FileDiff } from "@pierre/diffs/react";
import type { FileChange, Workspace } from "@/shared/types";
import { ChangesView } from "@/features/workspace/ui/ChangesView";
import { FilesView } from "@/features/workspace/ui/FilesView";
import { workspaceLayoutActions } from "@/features/workspace/store/workspaceLayoutStore";
import { DiffViewer } from "@/features/workspace/ui/DiffViewer";

const rename = {
  file: "東京 notes.md",
  previous_path: "old/café.md",
  status: "renamed",
  additions: 1,
  deletions: 0,
} as const;
const changes: FileChange[] = [
  { file: "empty", status: "added", additions: 0, deletions: 0 },
  { file: "appended", status: "modified", additions: 1, deletions: 0 },
  { file: "staged-deletion.txt", status: "deleted", additions: 0, deletions: 0 },
  { file: "unstaged-deletion.txt", status: "deleted", additions: 0, deletions: 1 },
  rename,
];
const workspace = { id: "w", kind: "worktree", state: "ready" } as Workspace;
vi.mock("@/features/file-browser/api/useFiles", () => ({
  useFiles: () => ({
    data: {
      files: ["appended", "empty", "unstaged-deletion.txt", "untouched.md", "東京 notes.md"].map(
        (name) => ({
          type: "file",
          path: name,
          name,
        })
      ),
    },
  }),
}));
vi.mock("@pierre/trees/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("@pierre/trees/react")>();
  return { ...real, useFileTree: vi.fn(real.useFileTree) };
});
vi.mock("@pierre/diffs/react", () => ({ FileDiff: vi.fn(() => null) }));
vi.mock("@/features/file-browser/lib/pierreIcons", () => ({ PierreFileIcon: () => null }));
vi.mock("@/shared/lib/diffOptions", () => ({ useDiffOptions: () => ({}) }));

const readChanges = vi.hoisted(() => vi.fn());
vi.mock("@/features/workspace/api/workspace.queries", () => ({ useFileChanges: readChanges }));
vi.mock("@/features/workspace/ui/ChangesDiffViewer", () => ({ ChangesDiffViewer: () => null }));
vi.mock("@/features/workspace/ui/CloudSandboxGate", () => ({ CloudSandboxGate: () => null }));

it("shows a failed read in the Changes tab and reserves the empty state for a successful read", () => {
  const render = () => renderToStaticMarkup(createElement(ChangesView, { workspace }));
  const error = new Error("Could not read the changes: git timed out.");
  readChanges.mockReturnValueOnce({ error });
  const failed = render();
  expect(failed).toContain(error.message);
  expect(failed).not.toContain("No file changes yet");
  readChanges.mockReturnValueOnce({ data: { files: [] } });
  expect(render()).toContain("No file changes yet");
});

it("shows the four statuses from git in Changes", () => {
  readChanges.mockReturnValueOnce({ data: { files: changes } });
  const list = renderToStaticMarkup(createElement(ChangesView, { workspace }));
  for (const { file, status, previous_path } of changes) {
    const description = previous_path ? `renamed from ${previous_path}` : status;
    expect(list).toContain(`aria-label="${file} (${description})"`);
  }
});

it("decorates the files in the Files tab and opens a rename at its current path", () => {
  readChanges.mockReturnValueOnce({ data: { files: changes } });
  renderToStaticMarkup(createElement(FilesView, { workspace }));
  const tree = vi.mocked(useFileTree);
  const options = tree.mock.lastCall![0];
  expect(options.gitStatus).toEqual([
    { path: "appended", status: "modified" },
    { path: "empty", status: "added" },
    { path: "unstaged-deletion.txt", status: "deleted" },
    { path: rename.file, status: "renamed" },
  ]);
  const { shadowHtml } = preloadFileTree(options);
  for (const status of ["added", "modified", "deleted", "renamed"]) {
    expect(shadowHtml).toContain(`title="Git status: ${status}">${status[0].toUpperCase()}</span>`);
  }
  expect(shadowHtml).toContain(`Renamed from ${rename.previous_path}`);
  const model = tree.mock.results.at(-1)!.value.model;
  expect(model.getItem("untouched.md")).not.toBeNull();
  expect(model.getItem("staged-deletion.txt")).toBeNull();
  const select = vi
    .spyOn(workspaceLayoutActions, "setSelectedFilePath")
    .mockImplementation(() => {});
  try {
    model.getItem(rename.file)!.select();
    expect(select).toHaveBeenCalledExactlyOnceWith(workspace.id, rename.file);
  } finally {
    select.mockRestore();
  }
});

it.each([true, false])("renders git's quoted rename with edits (full contents: %s)", (full) => {
  const fileChange = { ...rename, file: '東京 "notes".md' };
  const before = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n";
  const diff = `diff --git a/old/café.md "b/東京 \\"notes\\".md"
index b00a0f1..30a44a5 100644
--- a/old/café.md
+++ "b/東京 \\"notes\\".md"\t
@@ -6,3 +6,4 @@ five
 six
 seven
 eight
+nine
`;
  const data = {
    file: fileChange.file,
    diff,
    old_content: full ? before : null,
    new_content: full ? before + "nine\n" : null,
  };
  renderToStaticMarkup(createElement(DiffViewer, { fileChange, data, embedded: true }));
  const rendered = vi.mocked(FileDiff).mock.lastCall![0].fileDiff;
  expect(rendered).toMatchObject({
    name: fileChange.file,
    prevName: fileChange.previous_path,
    type: "rename-changed",
    isPartial: !full,
  });
  expect(rendered.hunks).toHaveLength(1);
  if (full) expect(rendered.hunks[0].collapsedBefore).toBeGreaterThan(0);
});

it("describes unchanged contents when git returns an empty patch for a pure rename", () => {
  const fileChange = { ...rename, file: "new/café.md", additions: 0 };
  const data = { file: fileChange.file, diff: "", old_content: "same", new_content: "same" };
  const html = renderToStaticMarkup(
    createElement(DiffViewer, { fileChange, data, embedded: true })
  );
  expect(html).toContain("The contents are unchanged.");
});
