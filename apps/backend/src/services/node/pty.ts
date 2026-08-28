/**
 * PTY node routing — send a terminal op to the node that owns the terminal.
 *
 * A cloud terminal lives on the sandbox; a local one on node-pty. `write`/
 * `resize`/`kill` route by `ptyId` (the cloud registry answers `isCloudPty`); a
 * spawn routes by the cloud workspace the frontend named. This centralizes the
 * four scattered `isCloudPty` branches that lived in `services/agent/commands.ts`.
 *
 * NOTE: a pty is a *stream*, not a request/response resource, so this is NOT part
 * of the `NodeDriver`. The long-term home for streaming across nodes is the NRP
 * wire (docs/node-mesh-plan.md); this router is the backend's local-vs-cloud
 * dispatch until then. Behavior is a byte-identical extraction of the previous
 * command handlers.
 */
import { getDatabase } from "../../lib/database";
import { getWorkspaceRaw } from "../../db/queries";
import { spawnPty, writeToPty, resizePty, killPty } from "../pty.service";
import {
  isCloudPty,
  openCloudPty,
  writeCloudPty,
  resizeCloudPty,
  killCloudPty,
} from "../agent/cloud/driver";

export interface PtySpawnParams {
  id: string;
  command: string;
  args: string[];
  cols: number;
  rows: number;
  cwd?: string;
  /** When set, the terminal runs on the named cloud workspace's sandbox. */
  cloudWorkspaceId?: string;
}

export const ptyRouter = {
  /** Open a terminal on the owning node; returns the pty id. */
  async open(params: PtySpawnParams): Promise<string> {
    // A cloud terminal never touches node-pty: the frontend names the cloud
    // WORKSPACE, the backend resolves its current session, and the driver
    // reroutes the same pty-data/pty-exit events — xterm cannot tell the
    // difference.
    if (params.cloudWorkspaceId) {
      const row = getWorkspaceRaw(getDatabase(), params.cloudWorkspaceId);
      const cloudSessionId = row?.current_session_id;
      if (!cloudSessionId) {
        throw new Error("Cloud workspace has no active session for a terminal");
      }
      await openCloudPty(cloudSessionId, {
        ptyId: params.id,
        cols: params.cols,
        rows: params.rows,
        cwd: params.cwd,
      });
      return params.id;
    }
    return spawnPty({
      id: params.id,
      command: params.command,
      args: params.args,
      cols: params.cols,
      rows: params.rows,
      cwd: params.cwd,
    });
  },

  /** Write input bytes to the terminal that owns `id` (cloud or local). */
  write(id: string, data: number[]): void {
    if (isCloudPty(id)) writeCloudPty(id, data);
    else writeToPty(id, data);
  },

  /** Resize the terminal that owns `id`. */
  resize(id: string, cols: number, rows: number): void {
    if (isCloudPty(id)) resizeCloudPty(id, cols, rows);
    else resizePty(id, cols, rows);
  },

  /** Kill the terminal that owns `id`. */
  kill(id: string): void {
    if (isCloudPty(id)) killCloudPty(id);
    else killPty(id);
  },
};
