/**
 * PTY Commands - Tauri Platform Wrapper
 *
 * Wrappers for Tauri invoke commands related to pseudoterminal operations
 */

import { invoke } from '../invoke';

export const ptyCommands = {
  spawn: (options: {
    id: string;
    command: string;
    args: string[];
    cols: number;
    rows: number;
    cwd: string;
  }): Promise<void> =>
    invoke<void>('spawn_pty', options),

  write: (id: string, data: number[]): Promise<void> =>
    invoke<void>('write_to_pty', { id, data }),

  resize: (id: string, cols: number, rows: number): Promise<void> =>
    invoke<void>('resize_pty', { id, cols, rows }),

  kill: (id: string): Promise<void> =>
    invoke<void>('kill_pty', { id }),
};
