/**
 * NodeDriver — owning-node dispatch for live-probe resources.
 *
 * See `docs/node-mesh-plan.md`, Phase 1. Live-probe resources (a worktree's
 * current diff, its file tree, a file's contents) can't be event-sourced ahead
 * of time; they're fetched per request from the node that owns the workspace.
 * This interface replaces the hand-written `workspace.kind === "cloud"` branches
 * with one dispatch keyed on the owning node: `resolveNode(workspace)` returns a
 * `LocalNodeDriver` (git + fs) or a `RemoteNodeDriver` (the cloud session
 * socket). Routes call `driver.method(...)` and serialize the result — they no
 * longer know which node answered.
 *
 * Covered so far: the **diff** and **fs** families. Streaming resources (pty)
 * and the agent turn are deliberately NOT here — they route through the NRP wire
 * later (Phase 4), not this request/response driver.
 *
 * The driver bodies are a faithful extraction of the previous route branches —
 * each lane's exact computation is preserved, not unified, so behavior is
 * byte-identical.
 */
import path from "path";
import fs from "fs";
import { getErrorMessage, isExecError } from "@shared/lib/errors";
import { ValidationError } from "../../lib/errors";
import * as gitService from "../git.service";
import * as filesService from "../files.service";
import { getCloudDiffSummary, getCloudDiffFile, requestCloudFs } from "../agent/cloud/driver";
import {
  listCloudTree,
  invalidateCloudTree,
  flattenCloudTree,
  cloudTreeToResponse,
  cloudFsOrThrow,
} from "./cloud-fs";
import { CLOUD_NODE_ID, formatRef, workspaceNodeId, workspaceRef } from "./index";
import type { WorkspaceWithDetailsRow } from "../../db";

// ─────────────────────────── result shapes ───────────────────────────

export interface DiffStats {
  additions: number;
  deletions: number;
}

export interface DiffFilesResult {
  files: Array<{ file: string; additions: number; deletions: number }>;
}

/**
 * A single-file diff outcome. Success carries the four content fields the route
 * serializes; failure carries the exact `{status, body}` the route used to build
 * inline, so the response is unchanged. (Invalid-path is thrown as a
 * `ValidationError` and handled by the error middleware, as before.)
 */
export type DiffFileOutcome =
  | {
      ok: true;
      file: string;
      diff: string;
      old_content: string | null;
      new_content: string | null;
    }
  | { ok: false; status: 500 | 502; body: Record<string, unknown> };

/** A file read: text content, or a 422 "binary" outcome. Bad paths throw. */
export type FsReadOutcome =
  | { ok: true; content: string }
  | { ok: false; status: 422; body: Record<string, unknown> };

/**
 * The workspace file tree the route serializes. `files` is left as `unknown[]`
 * because the two lanes' node shapes differ (local `FileTreeNode` vs the cloud
 * sandbox's mapped nodes); the container fields are what callers rely on.
 * `truncated` / `provisioning` are cloud-only.
 */
export interface FsTreeResponse {
  files: unknown[];
  totalFiles: number;
  totalSize: number;
  truncated?: boolean;
  provisioning?: boolean;
}

/** A fuzzy file-search hit — identical shape on both lanes. */
export interface FileMatch {
  path: string;
  name: string;
  score: number;
}

export interface NodeDriver {
  // diff family
  diffStats(): Promise<DiffStats>;
  diffFiles(): Promise<DiffFilesResult>;
  diffFile(file: string): Promise<DiffFileOutcome>;
  // fs family
  fsTree(): Promise<FsTreeResponse>;
  fsRead(filePath: string): Promise<FsReadOutcome>;
  fsSearch(query: string, limit: number): Promise<FileMatch[]>;
  fsInvalidate(): void;
}

// ─────────────────────────── local worktree ───────────────────────────

/** Local worktree — git + fs against the on-disk workspace path. */
class LocalNodeDriver implements NodeDriver {
  constructor(
    private readonly workspace: WorkspaceWithDetailsRow,
    private readonly workspacePath: string
  ) {}

  private parentBranch(): string {
    return gitService.resolveParentBranch(
      this.workspacePath,
      this.workspace.git_target_branch,
      this.workspace.git_default_branch
    );
  }

  async diffStats(): Promise<DiffStats> {
    return gitService.getDiffStats(this.workspacePath, this.parentBranch());
  }

  async diffFiles(): Promise<DiffFilesResult> {
    return { files: gitService.getDiffFiles(this.workspacePath, this.parentBranch()) };
  }

  async diffFile(file: string): Promise<DiffFileOutcome> {
    const workspacePath = this.workspacePath;
    const parentBranch = this.parentBranch();
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

      return { ok: true, file, diff: output, old_content: oldContent, new_content: newContent };
    } catch (gitError: unknown) {
      const msg = getErrorMessage(gitError);
      const killed = isExecError(gitError) && gitError.killed;
      const errorResponse: Record<string, unknown> = {
        error: "diff_failed",
        message: "Failed to get diff",
        retryable: true,
        details: { file, parentBranch, reason: null as string | null },
      };
      const details = errorResponse.details as Record<string, unknown>;
      if (killed) {
        errorResponse.message = "Diff operation timed out";
        details.reason = "timeout";
      } else if (msg.includes("unknown revision")) {
        errorResponse.message = "Parent branch not found";
        details.reason = "branch_not_found";
        errorResponse.retryable = false;
      } else if (msg.includes("not a git repository")) {
        errorResponse.message = "Not a git repository";
        details.reason = "not_git_repo";
        errorResponse.retryable = false;
      } else {
        details.reason = "git_error";
        details.errorMessage = msg;
      }
      return { ok: false, status: 500, body: errorResponse };
    }
  }

  async fsTree(): Promise<FsTreeResponse> {
    return filesService.scanWorkspaceFiles(this.workspacePath);
  }

  async fsRead(filePath: string): Promise<FsReadOutcome> {
    const workspacePath = this.workspacePath;
    const safeRelativePath = gitService.resolveWorkspaceRelativePath(workspacePath, filePath);
    if (!safeRelativePath) throw new ValidationError("Invalid file path");

    const absolutePath = path.resolve(workspacePath, safeRelativePath);
    if (!fs.existsSync(absolutePath)) {
      throw new ValidationError("File not found");
    }

    let realWorkspacePath: string;
    let realPath: string;
    try {
      realWorkspacePath = fs.realpathSync(workspacePath);
      realPath = fs.realpathSync(absolutePath);
    } catch {
      throw new ValidationError("File not found");
    }

    const relativeRealPath = path.relative(realWorkspacePath, realPath);
    if (relativeRealPath.startsWith("..") || path.isAbsolute(relativeRealPath)) {
      throw new ValidationError("Invalid file path");
    }

    const content = filesService.readTextFile(realPath);
    if (content === null) {
      return {
        ok: false,
        status: 422,
        body: { error: "binary_file", message: "File appears to be binary" },
      };
    }
    return { ok: true, content };
  }

  async fsSearch(query: string, limit: number): Promise<FileMatch[]> {
    // Empty query → return top-level files (short paths first)
    if (!query || typeof query !== "string") {
      return filesService.listTopFiles(this.workspacePath, limit);
    }
    return filesService.fuzzySearchFiles(this.workspacePath, query, limit);
  }

  fsInvalidate(): void {
    filesService.invalidateCache(this.workspacePath);
  }
}

// ─────────────────────────── cloud sandbox ───────────────────────────

/**
 * Cloud sandbox — live worktree over the session socket. A paused or
 * unreachable sandbox answers with the EMPTY shape, not an error: the Changes
 * and Files panels poll these routes and a sleeping computer legitimately has no
 * live worktree to show.
 */
class RemoteNodeDriver implements NodeDriver {
  constructor(private readonly workspace: WorkspaceWithDetailsRow) {}

  private async summary() {
    if (!this.workspace.current_session_id) return null;
    try {
      return await getCloudDiffSummary(this.workspace.current_session_id);
    } catch (err) {
      console.warn(
        `[Diff] cloud summary unavailable for ${formatRef(workspaceRef(this.workspace))}: ${getErrorMessage(err)}`
      );
      return null;
    }
  }

  async diffStats(): Promise<DiffStats> {
    const summary = await this.summary();
    return (summary?.files ?? []).reduce(
      (acc, f) => ({
        additions: acc.additions + (f.additions ?? 0),
        deletions: acc.deletions + (f.deletions ?? 0),
      }),
      { additions: 0, deletions: 0 }
    );
  }

  async diffFiles(): Promise<DiffFilesResult> {
    const summary = await this.summary();
    return {
      files: (summary?.files ?? []).map((f) => ({
        file: f.path,
        additions: f.additions ?? 0,
        deletions: f.deletions ?? 0,
      })),
    };
  }

  async diffFile(file: string): Promise<DiffFileOutcome> {
    const sessionId = this.workspace.current_session_id;
    if (!sessionId) return { ok: true, file, diff: "", old_content: null, new_content: null };
    try {
      // Content rides the fs channel (its owner since Sprint T); the diff
      // channel keeps only what it is named for. FILE/CONTENT is deprecated.
      const [diffPart, contentPart] = await Promise.all([
        getCloudDiffFile(sessionId, file, "DIFF"),
        requestCloudFs(sessionId, { op: "read", path: file }) as Promise<{
          content?: string;
          error?: string;
        }>,
      ]);
      if (diffPart.error) {
        throw new Error(diffPart.error);
      }
      // Content is enrichment, not a gate — a deleted file has a diff and no
      // bytes to read; failing the whole route hid the deletion entirely.
      // old_content is not reconstructable from the live channel (Sprint 3
      // serves it from fetched checkpoint objects); the diff text carries the
      // change either way, and the viewer already tolerates null contents
      // (binary files take the same shape locally).
      return {
        ok: true,
        file,
        diff: diffPart.diff ?? "",
        old_content: null,
        new_content: contentPart.content ?? null,
      };
    } catch (err) {
      return {
        ok: false,
        status: 502,
        body: {
          error: "diff_failed",
          message: `Cloud diff unavailable: ${getErrorMessage(err)}`,
          retryable: true,
        },
      };
    }
  }

  async fsTree(): Promise<FsTreeResponse> {
    // Null session = still provisioning; return an empty listing (not an error)
    // so Files shows "empty", not a dead panel that never refetches.
    const sessionId = this.workspace.current_session_id;
    if (!sessionId) return { files: [], totalFiles: 0, totalSize: 0, provisioning: true };
    const { tree, truncated } = await listCloudTree(sessionId);
    return { ...cloudTreeToResponse(tree), truncated };
  }

  async fsRead(filePath: string): Promise<FsReadOutcome> {
    // The sidecar enforces canonical containment; this mirrors the local
    // branch's early rejection so both lanes refuse the same inputs.
    if (filePath.split("/").includes("..")) throw new ValidationError("Invalid file path");
    const sessionId = this.workspace.current_session_id;
    if (!sessionId) throw new ValidationError("File not found");
    const data = (await cloudFsOrThrow(sessionId, { op: "read", path: filePath })) as {
      content?: string;
      error?: string;
    };
    if (data.error) throw new ValidationError(data.error);
    if (typeof data.content !== "string") {
      return {
        ok: false,
        status: 422,
        body: { error: "binary_file", message: "File appears to be binary" },
      };
    }
    return { ok: true, content: data.content };
  }

  async fsSearch(query: string, limit: number): Promise<FileMatch[]> {
    // Same scoring, computer truth: flatten the fs-channel tree and reuse the
    // local scorers — @-mentions and the Files filter work identically. The
    // shared cache means keystrokes after the first list are free.
    const sessionId = this.workspace.current_session_id;
    if (!sessionId) return [];
    const listed = await listCloudTree(sessionId).catch(() => null);
    if (!listed) return [];
    const paths = flattenCloudTree(listed.tree);
    return !query || typeof query !== "string"
      ? filesService.scoreTopFiles(paths, limit)
      : filesService.fuzzySearchPaths(paths, query, limit);
  }

  fsInvalidate(): void {
    if (this.workspace.current_session_id) invalidateCloudTree(this.workspace.current_session_id);
  }
}

/**
 * Resolve the driver for the node that owns this workspace's live resources.
 * The lane predicate is {@link workspaceNodeId}: only `kind === "cloud"` is
 * remote. `workspacePath` is the on-disk path for local workspaces (`""` for
 * cloud, unused there).
 */
export function resolveNode(workspace: WorkspaceWithDetailsRow, workspacePath: string): NodeDriver {
  return workspaceNodeId(workspace) === CLOUD_NODE_ID
    ? new RemoteNodeDriver(workspace)
    : new LocalNodeDriver(workspace, workspacePath);
}
