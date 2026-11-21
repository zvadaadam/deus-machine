/**
 * `resolveNode` routes workspace diff and file requests to the node that owns the workspace.
 * The local driver reads Git and the filesystem. The remote driver uses the cloud session socket.
 * See `docs/node-mesh-plan.md`.
 */
import path from "path";
import fs from "fs";
import { getErrorMessage, isExecError } from "@shared/lib/errors";
import type { FileMatch, FileTreeResponse } from "@shared/types/files";
import { AppError, ConflictError, ValidationError } from "../../lib/errors";
import * as gitService from "../git.service";
import * as filesService from "../files.service";
import {
  getCloudDiffSummary,
  getCloudDiffFile,
  hasLiveCloudSession,
  requestCloudFs,
} from "../agent/cloud/driver";
import {
  listCloudTree,
  invalidateCloudTree,
  flattenCloudTree,
  cloudTreeToResponse,
  cloudFsOrThrow,
} from "./cloud-fs";
import { CLOUD_NODE_ID, workspaceNodeId } from "./index";
import type { WorkspaceWithDetailsRow } from "../../db";

// ─────────────────────────── result shapes ───────────────────────────

export interface DiffStats {
  additions: number;
  deletions: number;
}

export interface DiffFilesResult {
  files: Array<{ file: string; additions: number; deletions: number }>;
}

/** A file diff with available contents. On failure, local reads throw and cloud reads return 502. */
export type DiffFileOutcome =
  | {
      ok: true;
      file: string;
      diff: string;
      old_content: string | null;
      new_content: string | null;
    }
  | { ok: false; status: 502; body: Record<string, unknown> };

/** A file read: text content, or a 422 "binary" outcome. Bad paths throw. */
export type FsReadOutcome =
  | { ok: true; content: string }
  | { ok: false; status: 422; body: Record<string, unknown> };

export interface NodeDriver {
  // diff family
  diffStats(): Promise<DiffStats>;
  diffFiles(): Promise<DiffFilesResult>;
  diffFile(file: string): Promise<DiffFileOutcome>;
  // fs family
  fsTree(): Promise<FileTreeResponse>;
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

  private async readChanges<T>(read: (parent: string) => Promise<T>): Promise<T> {
    try {
      const parent = await gitService.resolveParentBranch(
        this.workspacePath,
        this.workspace.git_target_branch,
        this.workspace.git_default_branch
      );
      return await read(parent);
    } catch (error) {
      if (error instanceof AppError) throw error;
      // A git diagnostic can contain private paths or repository-controlled text.
      const failure = isExecError(error) ? error : undefined;
      let reason = failure?.code ? `git failed (${failure.code})` : "git could not finish the read";
      if (failure?.killed) reason = "git timed out";
      else if (failure?.stderr?.includes("not a git repository"))
        reason = "the workspace is not a git repository";
      else if (/unknown revision|not a valid (object|commit) name/i.test(failure?.stderr ?? ""))
        reason = "the comparison branch could not be found";
      throw new ConflictError(`Could not read the changes: ${reason}.`);
    }
  }

  diffStats(): Promise<DiffStats> {
    return this.readChanges((parent) => gitService.getDiffStats(this.workspacePath, parent));
  }

  async diffFiles(): Promise<DiffFilesResult> {
    return {
      files: await this.readChanges((parent) =>
        gitService.getDiffFiles(this.workspacePath, parent)
      ),
    };
  }

  async diffFile(file: string): Promise<DiffFileOutcome> {
    const workspacePath = this.workspacePath;
    const safeFilePath = gitService.resolveWorkspaceRelativePath(workspacePath, file);
    if (!safeFilePath) throw new ValidationError("Invalid file path");

    return this.readChanges(async (parent) => {
      const mergeBase = await gitService.getMergeBase(workspacePath, parent);
      const output = await gitService.getFileDiff(workspacePath, mergeBase, safeFilePath);
      const diffInfo = gitService.extractDiffInfo(output);
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
        oldContent = await gitService.getGitFileContent(workspacePath, mergeBase, safeOldPath);
      }

      if (diffInfo.isDeleted) {
        newContent = "";
      } else {
        // Read from working directory (not HEAD) since we diff merge-base against workdir
        try {
          const buf = await fs.promises.readFile(path.resolve(workspacePath, safeNewPath));
          // Detect binary files (null bytes in first 8KB)
          const sample = buf.subarray(0, 8192);
          newContent = sample.includes(0) ? null : buf.toString("utf-8");
        } catch {
          newContent = await gitService.getGitFileContent(workspacePath, "HEAD", safeNewPath);
        }
      }

      return { ok: true, file, diff: output, old_content: oldContent, new_content: newContent };
    });
  }

  async fsTree(): Promise<FileTreeResponse> {
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
        `[Diff] cloud summary unavailable for ${this.workspace.id}: ${getErrorMessage(err)}`
      );
      return null;
    }
  }

  /**
   * The sidebar's numbers ask every ready workspace on mount and on focus. A
   * `diff.request` to a computer whose agent is not connected makes the platform
   * connect it, which resumes an idle-paused sandbox (AGNT `client-handler.ts`
   * `sidecarConnected` → `WorkspaceDO.requestConnection` → `recoverSandbox`). So
   * the numbers ask only a computer this backend already holds a channel to and
   * that is not asleep; any other answers the empty shape without connecting.
   */
  async diffStats(): Promise<DiffStats> {
    const sessionId = this.workspace.current_session_id;
    const asleep = ["paused", "stopped", "resuming", "error"].includes(
      this.workspace.init_stage ?? ""
    );
    if (!sessionId || asleep || !hasLiveCloudSession(sessionId)) {
      return { additions: 0, deletions: 0 };
    }
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
        // Content is enrichment, not a gate (see below): a read that REJECTS
        // (transient fs error, an unreadable/deleted file) must not fail an
        // available diff, so fall back to no content instead of rejecting the
        // whole Promise.all.
        (
          requestCloudFs(sessionId, { op: "read", path: file }) as Promise<{
            content?: string;
            error?: string;
          }>
        ).catch(() => ({}) as { content?: string; error?: string }),
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

  async fsTree(): Promise<FileTreeResponse> {
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
