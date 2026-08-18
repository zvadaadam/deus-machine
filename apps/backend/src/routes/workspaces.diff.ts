import { Hono } from "hono";
import path from "path";
import fs from "fs";
import { getErrorMessage, isExecError } from "@shared/lib/errors";
import { withWorkspace } from "../middleware/workspace-loader";
import { ValidationError } from "../lib/errors";
import * as gitService from "../services/git.service";
import { getCloudDiffSummary, getCloudDiffFile } from "../services/agent/cloud/driver";
import type { WorkspaceWithDetailsRow } from "../db";

type Env = { Variables: { workspace: WorkspaceWithDetailsRow; workspacePath: string } };
const app = new Hono<Env>();

/**
 * Cloud workspaces serve diffs from the sandbox's live worktree over the
 * session socket (diff.request SUMMARY/FILE) instead of local git. A paused
 * or unreachable sandbox answers with the EMPTY shape, not an error — the
 * Changes panel polls these routes, and a sleeping workspace legitimately has
 * no live diff to show.
 */
async function cloudSummary(workspace: WorkspaceWithDetailsRow) {
  if (!workspace.current_session_id) return null;
  try {
    return await getCloudDiffSummary(workspace.current_session_id);
  } catch (err) {
    console.warn(`[Diff] cloud summary unavailable for ${workspace.id}: ${getErrorMessage(err)}`);
    return null;
  }
}

// Diff stats - uses withWorkspace middleware
app.get("/workspaces/:id/diff-stats", withWorkspace, async (c) => {
  const workspace = c.get("workspace");
  if (workspace.kind === "cloud") {
    const summary = await cloudSummary(workspace);
    const stats = (summary?.files ?? []).reduce(
      (acc, f) => ({
        additions: acc.additions + (f.additions ?? 0),
        deletions: acc.deletions + (f.deletions ?? 0),
      }),
      { additions: 0, deletions: 0 }
    );
    return c.json(stats);
  }
  const workspacePath = c.get("workspacePath");
  const parentBranch = gitService.resolveParentBranch(
    workspacePath,
    workspace.git_target_branch,
    workspace.git_default_branch
  );
  const stats = gitService.getDiffStats(workspacePath, parentBranch);
  return c.json(stats);
});

// Diff files
app.get("/workspaces/:id/diff-files", withWorkspace, async (c) => {
  const workspace = c.get("workspace");
  if (workspace.kind === "cloud") {
    const summary = await cloudSummary(workspace);
    const files = (summary?.files ?? []).map((f) => ({
      file: f.path,
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
    }));
    return c.json({ files });
  }
  const workspacePath = c.get("workspacePath");
  const parentBranch = gitService.resolveParentBranch(
    workspacePath,
    workspace.git_target_branch,
    workspace.git_default_branch
  );
  const files = gitService.getDiffFiles(workspacePath, parentBranch);
  return c.json({ files });
});

// Diff file content
app.get("/workspaces/:id/diff-file", withWorkspace, async (c) => {
  const file = c.req.query("file");
  if (!file) throw new ValidationError("file parameter is required");

  const workspace = c.get("workspace");
  if (workspace.kind === "cloud") {
    const sessionId = workspace.current_session_id;
    if (!sessionId) return c.json({ file, diff: "", old_content: null, new_content: null });
    try {
      const [diffPart, contentPart] = await Promise.all([
        getCloudDiffFile(sessionId, file, "DIFF"),
        getCloudDiffFile(sessionId, file, "CONTENT"),
      ]);
      if (diffPart.error || contentPart.error) {
        throw new Error(diffPart.error ?? contentPart.error);
      }
      // old_content is not reconstructable from the live channel (Sprint 3
      // serves it from fetched checkpoint objects); the diff text carries the
      // change either way, and the viewer already tolerates null contents
      // (binary files take the same shape locally).
      return c.json({
        file,
        diff: diffPart.diff ?? "",
        old_content: null,
        new_content: contentPart.content ?? null,
      });
    } catch (err) {
      return c.json(
        {
          error: "diff_failed",
          message: `Cloud diff unavailable: ${getErrorMessage(err)}`,
          retryable: true,
        },
        502
      );
    }
  }
  const workspacePath = c.get("workspacePath");
  const parentBranch = gitService.resolveParentBranch(
    workspacePath,
    workspace.git_target_branch,
    workspace.git_default_branch
  );
  const safeFilePath = gitService.resolveWorkspaceRelativePath(workspacePath, file);
  if (!safeFilePath) throw new ValidationError("Invalid file path");

  try {
    const output = gitService.getFileDiff(workspacePath, parentBranch, safeFilePath);
    const diffInfo = gitService.extractDiffInfo(output);
    const mergeBase = gitService.getMergeBase(workspacePath, parentBranch);
    const safeOldPath =
      gitService.resolveWorkspaceRelativePath(workspacePath, diffInfo.oldPath || safeFilePath) ||
      safeFilePath;
    const safeNewPath =
      gitService.resolveWorkspaceRelativePath(workspacePath, diffInfo.newPath || safeFilePath) ||
      safeFilePath;

    let oldContent: string | null = null;
    let newContent: string | null = null;

    if (diffInfo.isNew) {
      oldContent = "";
    } else {
      oldContent = gitService.getGitFileContent(workspacePath, mergeBase, safeOldPath);
    }

    if (diffInfo.isDeleted) {
      newContent = "";
    } else {
      // Read from working directory (not HEAD) since we diff merge-base against workdir
      try {
        const buf = fs.readFileSync(path.resolve(workspacePath, safeNewPath));
        // Detect binary files (null bytes in first 8KB)
        const sample = buf.subarray(0, 8192);
        newContent = sample.includes(0) ? null : buf.toString("utf-8");
      } catch {
        newContent = gitService.getGitFileContent(workspacePath, "HEAD", safeNewPath);
      }
    }

    return c.json({ file, diff: output, old_content: oldContent, new_content: newContent });
  } catch (gitError: unknown) {
    const msg = getErrorMessage(gitError);
    const killed = isExecError(gitError) && gitError.killed;
    const errorResponse: any = {
      error: "diff_failed",
      message: "Failed to get diff",
      retryable: true,
      details: { file, parentBranch, reason: null as string | null },
    };
    if (killed) {
      errorResponse.message = "Diff operation timed out";
      errorResponse.details.reason = "timeout";
    } else if (msg.includes("unknown revision")) {
      errorResponse.message = "Parent branch not found";
      errorResponse.details.reason = "branch_not_found";
      errorResponse.retryable = false;
    } else if (msg.includes("not a git repository")) {
      errorResponse.message = "Not a git repository";
      errorResponse.details.reason = "not_git_repo";
      errorResponse.retryable = false;
    } else {
      errorResponse.details.reason = "git_error";
      errorResponse.details.errorMessage = msg;
    }
    return c.json(errorResponse, 500);
  }
});

export default app;
