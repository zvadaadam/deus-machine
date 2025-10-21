/**
 * PTY Commands - Tauri Platform Wrapper
 *
 * Wrappers for Tauri invoke commands related to pseudoterminal operations
 */

import { invoke } from '@tauri-apps/api/core';

export const ptyCommands = {
  spawn: (options: {
    id: string;
    command: string;
    args: string[];
    cols: number;
    rows: number;
    cwd: string;
  }) =>
    invoke('spawn_pty', options),

  write: (id: string, data: number[]) =>
    invoke('write_to_pty', { id, data }),

  resize: (id: string, cols: number, rows: number) =>
    invoke('resize_pty', { id, cols, rows }),

  kill: (id: string) =>
    invoke('kill_pty', { id }),
};
