import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { Workspace } from "@/shared/types";
import { ChangesView } from "@/features/workspace/ui/ChangesView";

const result = vi.hoisted(() => ({ error: null as Error | null, data: { files: [] } }));
vi.mock("@/features/workspace/api/workspace.queries", () => ({ useFileChanges: () => result }));
vi.mock("@/features/workspace/ui/ChangesDiffViewer", () => ({ ChangesDiffViewer: () => null }));
vi.mock("@/features/workspace/ui/CloudSandboxGate", () => ({ CloudSandboxGate: () => null }));

it("shows a failed read in the Changes tab and reserves the empty state for a successful read", () => {
  const workspace = { id: "w", kind: "worktree", state: "ready" } as Workspace;
  const render = () => renderToStaticMarkup(createElement(ChangesView, { workspace }));
  result.error = new Error("Could not read the changes: git timed out.");
  const failed = render();
  expect(failed).toContain(result.error.message);
  expect(failed).not.toContain("No file changes yet");
  result.error = null;
  expect(render()).toContain("No file changes yet");
});
