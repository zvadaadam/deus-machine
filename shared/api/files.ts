/** Files: a workspace's file tree, file contents and search, and watching for changes. */

import { z } from "zod";
import type { FileMatch, FileTreeResponse } from "../types/files";
import { out, read } from "./op";
import { stream } from "./stream";

const workspaceId = z.object({ workspaceId: z.string().min(1) });

/** An origin-relative /api path for direct callers, or an absolute URL for a paired relay device. */
export const fileUrl = read({
  name: "fileUrl",
  input: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("recording"), path: z.string().min(1) }),
    workspaceId.extend({ kind: z.literal("preview"), path: z.string().min(1) }),
  ]),
  output: out<{ url: string }>(),
});

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

/** A local checkout changed. Its followers read the files and diffs again. */
export const fileChanges = stream({
  name: "fileChanges",
  scope: workspaceId,
  event: out<null>(),
});
