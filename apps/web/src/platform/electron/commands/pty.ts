/**
 * PTY Commands — WebSocket Protocol
 *
 * Routes PTY operations through the backend WebSocket query protocol.
 * The backend runs node-pty and streams data/exit events via q:event frames.
 */

import { sendCommand } from "../../ws/query-protocol-client";

export const ptyCommands = {
  spawn: (options: {
    id: string;
    command: string;
    args: string[];
    cols: number;
    rows: number;
    cwd: string;
  }): Promise<void> => sendCommand("pty:spawn", options).then(() => {}),

  write: (id: string, data: number[]): Promise<void> =>
    sendCommand("pty:write", { id, data }).then(() => {}),

  resize: (id: string, cols: number, rows: number): Promise<void> =>
    sendCommand("pty:resize", { id, cols, rows }).then(() => {}),

  kill: (id: string): Promise<void> => sendCommand("pty:kill", { id }).then(() => {}),
};
