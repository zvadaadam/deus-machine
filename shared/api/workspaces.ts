/** Workspaces: the list, one workspace's facts, its diff and its lifecycle. */

import { z } from "zod";
import { WorkspaceStatusSchema } from "../enums";
import type { GhCliStatus, PRStatus } from "../types/github";
import type { ProjectEnvironmentResponse, TaskRunResponse } from "../types/project-environment";
import type {
  ArchivedWorkspace,
  DiffStats,
  FileChange,
  RepoGroup,
  Workspace,
} from "../types/workspace";
import { live, out, read, write } from "./op";
import { stream } from "./stream";
import type { CloudEnvEvent, CloudIdentityEvent } from "../events";

const workspaceId = z.object({ workspaceId: z.string().min(1) });
const branchName = z
  .string()
  .refine((name) => !name.startsWith("-"), "Branch name must not start with a dash");

/** The sidebar: workspaces grouped by repository. `state` is a comma-separated filter. */
export const workspaces = live({
  name: "workspaces",
  input: z.object({ state: z.string().optional() }),
  output: out<RepoGroup[]>(),
});

export const workspace = read({ name: "workspace", input: workspaceId, output: out<Workspace>() });

export const archivedWorkspaces = read({
  name: "archivedWorkspaces",
  input: z.object({ repositoryId: z.string().min(1) }),
  output: out<ArchivedWorkspace[]>(),
});

/** The project's environment and Run commands, read on the node that owns the workspace. */
export const workspaceEnvironment = read({
  name: "workspaceEnvironment",
  input: workspaceId,
  output: out<ProjectEnvironmentResponse>(),
});

export const setupLogs = read({
  name: "setupLogs",
  input: workspaceId,
  output: out<{ logs: string | null }>(),
});

/** Lines added and removed against the workspace's target branch on origin. */
export const diffStats = read({ name: "diffStats", input: workspaceId, output: out<DiffStats>() });

export const diffFiles = read({
  name: "diffFiles",
  input: workspaceId,
  /** `truncated` and `total_count` are set when the diff holds more files than are listed. */
  output: out<{ files: FileChange[]; truncated?: boolean; total_count?: number }>(),
});

export const diffFile = read({
  name: "diffFile",
  input: workspaceId.extend({ file: z.string().min(1) }),
  output: out<{
    file: string;
    diff: string;
    old_content: string | null;
    new_content: string | null;
  }>(),
});

/** The workspace's pull request. Reading it also stores the snapshot the sidebar shows. */
export const prStatus = read({
  name: "prStatus",
  input: workspaceId,
  output: out<PRStatus | null>(),
});

/** Whether GitHub is installed and signed in on this computer, and as whom. */
export const ghStatus = read({ name: "ghStatus", output: out<GhCliStatus>() });

/**
 * Sign this computer's GitHub CLI in. Answers with GitHub's one-time code and
 * the page to enter it on; `ghLoginDone` answers when the sign-in ends.
 */
export const ghLogin = write({ name: "ghLogin", output: out<{ code: string; url: string }>() });

/** The end of the sign-in `ghLogin` began: within ten minutes, or its failure. */
export const ghLoginDone = read({ name: "ghLoginDone", output: out<void>() });

/** Sign the active github.com account out of this computer's GitHub CLI. */
export const ghLogout = write({ name: "ghLogout", output: out<void>() });

export const createWorkspace = write({
  name: "createWorkspace",
  input: z.object({
    repository_id: z.string().min(1),
    /** A local git worktree (the default) or a cloud sandbox. */
    location: z.enum(["local", "cloud"]).optional(),
    /** The remote branch to start from; the repository's default when omitted. */
    source_branch: branchName.optional(),
    pr_number: z.number().int().positive().optional(),
    pr_url: z.string().url().optional(),
    pr_title: z.string().optional(),
    /** The pull request's base branch: what the diff is measured against. */
    target_branch: branchName.optional(),
    /** A cloud workspace's organization; the default organization when omitted. */
    organization_id: z.string().min(1).optional(),
  }),
  /** The row exists at once in `initializing`; the rest arrives on `workspaces`. */
  output: out<{ workspaceId: string }>(),
});

/** Restore an archived workspace. */
export const updateWorkspace = write({
  name: "updateWorkspace",
  input: workspaceId.extend({ state: z.literal("ready") }),
  output: out<void>(),
});

export const archiveWorkspace = write({
  name: "archiveWorkspace",
  input: workspaceId,
  output: out<void>(),
});

export const updateWorkspaceTitle = write({
  name: "updateWorkspaceTitle",
  input: workspaceId.extend({ title: z.string() }),
  output: out<void>(),
});

export const updateWorkspaceStatus = write({
  name: "updateWorkspaceStatus",
  input: workspaceId.extend({ status: WorkspaceStatusSchema }),
  output: out<void>(),
});

/** Run the project's setup again after it failed. */
export const retrySetup = write({ name: "retrySetup", input: workspaceId, output: out<void>() });

/**
 * Start a workspace that failed to start again, on the same row: its name, its
 * branch and whatever a client keeps for it (the first message) stay put.
 * Progress arrives on `workspaces`.
 */
export const retryWorkspaceInit = write({
  name: "retryWorkspaceInit",
  input: workspaceId,
  output: out<void>(),
});

/** Remove a workspace that never started. One that did is archived instead. */
export const deleteWorkspace = write({
  name: "deleteWorkspace",
  input: workspaceId,
  output: out<void>(),
});

/** Resolve one of the project's Run commands into what a terminal should execute. */
export const runTask = write({
  name: "runTask",
  input: workspaceId.extend({ taskName: z.string().min(1) }),
  output: out<TaskRunResponse>(),
});

/** Wake a paused cloud sandbox and reopen its session channel. */
export const wakeCloudWorkspace = write({
  name: "wakeCloudWorkspace",
  input: workspaceId,
  output: out<{ ok: boolean; status: string; error?: string }>(),
});

/**
 * Open a cloud workspace's session channel without waking its sandbox, so the
 * row learns the sandbox's real state. Answers once the channel is open, or after
 * a few seconds if it does not open; the truth arrives on `workspaces`.
 */
export const connectCloudWorkspace = write({
  name: "connectCloudWorkspace",
  input: workspaceId,
  output: out<{ ok: boolean }>(),
});

// ---- Streams ----

/** A cloud workspace's sandbox as it is provisioned, woken, paused or fails. Not stored. */
export const cloudEnvironment = stream({
  name: "cloudEnvironment",
  scope: z.object({ workspaceId: z.string() }),
  event: out<CloudEnvEvent>(),
});

/**
 * This computer signed in to another Deus account, or out: what a client
 * cached about cloud devices and previews belonged to the previous one.
 */
export const cloudIdentity = stream({ name: "cloudIdentity", event: out<CloudIdentityEvent>() });
