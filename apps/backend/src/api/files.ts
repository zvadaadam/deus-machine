/** Answers the operations in `shared/api/files.ts`. */

import * as api from "@shared/api/files";
import { AppError, ValidationError } from "../lib/errors";
import { loadWorkspace } from "../middleware/workspace-loader";
import { resolveBrowserFile } from "../services/browser-files";
import { getRelayStatus } from "../services/relay.service";
import { fileHandles } from "../services/relay-file-handles";
import { watchWorkspace } from "../services/fs-watcher.service";
import { resolveNode } from "../services/node/driver";
import { onFollow, openWith } from "../services/streams";
import { handle } from "./registry";

/** The workspace's files, on whichever node owns them (this computer or its cloud sandbox). */
function nodeOf(workspaceId: string) {
  const { workspace, workspacePath } = loadWorkspace(workspaceId);
  return resolveNode(workspace, workspacePath);
}

onFollow(api.fileChanges, ({ workspaceId }) => {
  const { workspace, workspacePath } = loadWorkspace(workspaceId);
  if (!workspacePath || !workspace.current_session_id || workspace.state === "archived") {
    throw new ValidationError("This workspace has no local checkout to watch.");
  }
  return watchWorkspace(workspaceId, workspacePath);
});
openWith(api.fileChanges, () => [null]);

export default [
  handle(api.fileUrl, (input, { caller }) => {
    if (!caller.relayed) {
      const route =
        input.kind === "recording"
          ? "/api/files/stream"
          : `/api/workspaces/${encodeURIComponent(input.workspaceId)}/file-preview`;
      return { url: `${route}?path=${encodeURIComponent(input.path)}` };
    }
    const { serverId, relayUrl } = getRelayStatus();
    if (!caller.deviceId || !serverId) throw new AppError(403, "A paired device is required.");
    const file = resolveBrowserFile(input);
    if (file.type.startsWith("text/html"))
      throw new ValidationError("HTML previews are available only on a direct connection.");
    const handle = fileHandles.issue(caller.deviceId, file);
    const url = new URL(
      `/api/servers/${serverId}/files/${fileHandles.routeKey}/${handle}`,
      relayUrl
    );
    if (url.protocol === "ws:") url.protocol = "http:";
    if (url.protocol === "wss:") url.protocol = "https:";
    return { url: url.href };
  }),
  handle(api.workspaceFiles, ({ workspaceId }) => nodeOf(workspaceId).fsTree()),
  handle(api.fileContent, async ({ workspaceId, path }) => {
    const outcome = await nodeOf(workspaceId).fsRead(path);
    if (!outcome.ok) throw AppError.fromBody(outcome.status, outcome.body);
    return { content: outcome.content };
  }),
  handle(api.fileSearch, ({ workspaceId, query, limit }) =>
    nodeOf(workspaceId).fsSearch(query, limit)
  ),
];
