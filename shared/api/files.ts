/** Files: a workspace's file tree, file contents and search, and watching for changes. */

import { z } from "zod";
import type { FileMatch, FileTreeResponse } from "../types/files";
import { out, read, write } from "./op";
import { stream } from "./stream";

const workspaceId = z.object({ workspaceId: z.string().min(1) });
/** A folder on the computer that runs the backend, as an absolute path. */
const workspacePath = z.object({ workspacePath: z.string().min(1) });

/** The workspace's files as a tree, ignored files left out. */
export const workspaceFiles = read({
  name: "workspaceFiles",
  input: workspaceId,
  output: out<FileTreeResponse>(),
});

/**
 * A text file as it is in the workspace now, uncommitted changes included.
 * A binary file is refused as `binary_file`.
 */
export const fileContent = read({
  name: "fileContent",
  input: workspaceId.extend({
    /** Relative to the workspace root. */
    path: z.string().min(1),
  }),
  output: out<{ content: string }>(),
});

/** Files whose path matches `query`, best first; with no query, the files nearest the root. */
export const fileSearch = read({
  name: "fileSearch",
  input: workspaceId.extend({
    query: z.string().default(""),
    limit: z.number().int().positive().default(15),
  }),
  output: out<FileMatch[]>(),
});

/** Forget the listed tree, so the next read lists the workspace again. */
export const invalidateFileCache = write({
  name: "invalidateFileCache",
  input: workspaceId,
  output: out<void>(),
});

/** Start announcing changes under a local workspace's folder on `fileChanges`. */
export const fsWatch = write({ name: "fsWatch", input: workspacePath, output: out<void>() });

export const fsUnwatch = write({ name: "fsUnwatch", input: workspacePath, output: out<void>() });

export interface FileChangeEvent {
  change_type: "add" | "change" | "unlink" | "mixed" | "metadataonly";
  affected_count: number;
}

/** Files changed in a watched workspace folder (see `fsWatch`), a burst at a time. */
export const fileChanges = stream({
  name: "fileChanges",
  scope: workspacePath,
  event: out<FileChangeEvent>(),
});
