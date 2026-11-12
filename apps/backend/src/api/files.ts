/** Answers the operations in `shared/api/files.ts`. */

import * as api from "@shared/api/files";
import { AppError } from "../lib/errors";
import { loadWorkspace } from "../middleware/workspace-loader";
import { unwatchWorkspace, watchWorkspace } from "../services/fs-watcher.service";
import { resolveNode } from "../services/node/driver";
import { handle } from "./registry";

/** The workspace's files, on whichever node owns them (this computer or its cloud sandbox). */
function nodeOf(workspaceId: string) {
  const { workspace, workspacePath } = loadWorkspace(workspaceId);
  return resolveNode(workspace, workspacePath);
}

export default [
  handle(api.workspaceFiles, ({ workspaceId }) => nodeOf(workspaceId).fsTree()),
  handle(api.fileContent, async ({ workspaceId, path }) => {
    const outcome = await nodeOf(workspaceId).fsRead(path);
    if (!outcome.ok) throw AppError.fromBody(outcome.status, outcome.body);
    return { content: outcome.content };
  }),
  handle(api.fileSearch, ({ workspaceId, query, limit }) =>
    nodeOf(workspaceId).fsSearch(query, limit)
  ),

  handle(api.invalidateFileCache, ({ workspaceId }) => nodeOf(workspaceId).fsInvalidate()),
  handle(api.fsWatch, ({ workspacePath }) => watchWorkspace(workspacePath)),
  handle(api.fsUnwatch, ({ workspacePath }) => unwatchWorkspace(workspacePath)),
];
