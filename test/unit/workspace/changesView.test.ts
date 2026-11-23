import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { preloadFileTree } from "@pierre/trees";
import { useFileTree } from "@pierre/trees/react";
import { FileDiff } from "@pierre/diffs/react";
import type { FileChange, Workspace } from "@/shared/types";
import { ChangesView } from "@/features/workspace/ui/ChangesView";
import { ChangesFilesPanel } from "@/features/workspace/ui/ChangesFilesPanel";
import { FileBrowserPanel } from "@/features/file-browser/ui/FileBrowserPanel";
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
  { file: "removed", status: "deleted", additions: 0, deletions: 0 },
  rename,
];
const workspace = { id: "w", kind: "worktree", state: "ready" } as Workspace;
vi.mock("@/features/file-browser/api/useFiles", () => ({
  useFiles: () => ({
    data: { files: changes.map(({ file }) => ({ type: "file", path: file, name: file })) },
  }),
}));
vi.mock("@pierre/trees/react", async (importOriginal) => {
  const real = await importOriginal<typeof import("@pierre/trees/react")>();
  return { ...real, useFileTree: vi.fn(real.useFileTree) };
});
vi.mock("@pierre/diffs/react", () => ({ FileDiff: vi.fn(() => null) }));
vi.mock("@/features/file-browser/lib/pierreIcons", () => ({ PierreFileIcon: () => null }));
vi.mock("@/shared/lib/diffOptions", () => ({ useDiffOptions: () => ({}) }));

const result = vi.hoisted(() => ({ error: null as Error | null, data: { files: [] } }));
vi.mock("@/features/workspace/api/workspace.queries", () => ({ useFileChanges: () => result }));
vi.mock("@/features/workspace/ui/ChangesDiffViewer", () => ({ ChangesDiffViewer: () => null }));
vi.mock("@/features/workspace/ui/CloudSandboxGate", () => ({ CloudSandboxGate: () => null }));

it("shows a failed read in the Changes tab and reserves the empty state for a successful read", () => {
  const render = () => renderToStaticMarkup(createElement(ChangesView, { workspace }));
  result.error = new Error("Could not read the changes: git timed out.");
  const failed = render();
  expect(failed).toContain(result.error.message);
  expect(failed).not.toContain("No file changes yet");
  result.error = null;
  expect(render()).toContain("No file changes yet");
});

it("uses git's four statuses in Changes and the Files changed tree and opens the new name", () => {
  const onFileClick = vi.fn();
  const list = renderToStaticMarkup(
    createElement(ChangesFilesPanel, { fileChanges: changes, selectedFile: null, onFileClick })
  );
  renderToStaticMarkup(
    createElement(FileBrowserPanel, {
      selectedWorkspace: workspace,
      fileChanges: changes,
      filterMode: "changes",
      onFileClick,
    })
  );
  const tree = vi.mocked(useFileTree);
  const options = tree.mock.lastCall![0];
  expect(options.gitStatus).toEqual(changes.map(({ file, status }) => ({ path: file, status })));
  const { shadowHtml } = preloadFileTree(options);
  for (const { file, status, previous_path } of changes) {
    const description = previous_path ? `renamed from ${previous_path}` : status;
    expect(list).toContain(`aria-label="${file} (${description})"`);
    expect(shadowHtml).toContain(`title="Git status: ${status}">${status[0].toUpperCase()}</span>`);
  }
  expect(shadowHtml).toContain(`Renamed from ${rename.previous_path}`);
  tree.mock.results[0].value.model.getItem(rename.file)!.select();
  expect(onFileClick).toHaveBeenCalledWith(rename.file);
});

it.each([true, false])("renders git's quoted rename with edits (full contents: %s)", (full) => {
  const before = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\n";
  const diff = String.raw`diff --git "a/old/caf\303\251.md" "b/\346\235\261\344\272\254 notes.md"
similarity index 90%
rename from "old/caf\303\251.md"
rename to "\346\235\261\344\272\254 notes.md"
--- "a/old/caf\303\251.md"
+++ "b/\346\235\261\344\272\254 notes.md"
@@ -8 +8,2 @@
 eight
+nine
`;
  const data = {
    file: rename.file,
    diff,
    old_content: full ? before : null,
    new_content: full ? before + "nine\n" : null,
  };
  renderToStaticMarkup(createElement(DiffViewer, { fileChange: rename, data, embedded: true }));
  const rendered = vi.mocked(FileDiff).mock.lastCall![0].fileDiff;
  expect(rendered).toMatchObject({
    name: rename.file,
    prevName: rename.previous_path,
    type: "rename-changed",
    isPartial: !full,
  });
  expect(rendered.hunks).toHaveLength(1);
  if (full) expect(rendered.hunks[0].collapsedBefore).toBeGreaterThan(0);
});

it("opens a renamed file with no edits, including a move that keeps the basename", () => {
  const fileChange = { ...rename, file: "new/café.md" };
  const data = {
    file: fileChange.file,
    diff: String.raw`diff --git "a/old/caf\303\251.md" "b/new/caf\303\251.md"
similarity index 100%
rename from "old/caf\303\251.md"
rename to "new/caf\303\251.md"
`,
    old_content: "same",
    new_content: "same",
  };
  renderToStaticMarkup(createElement(DiffViewer, { fileChange, data, embedded: true }));
  expect(vi.mocked(FileDiff).mock.lastCall![0].fileDiff).toMatchObject({
    name: data.file,
    prevName: rename.previous_path,
    type: "rename-pure",
    hunks: [],
  });
});
