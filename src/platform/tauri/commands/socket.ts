/**
 * Socket Commands - Tauri Platform Wrapper
 *
 * Wrappers for Tauri invoke commands related to socket operations
 */

import { invoke } from '../invoke';

export const socketCommands = {
  connect: (path: string): Promise<void> =>
    invoke<void>('socket_connect', { path }),

  send: (data: string): Promise<void> =>
    invoke<void>('socket_send', { data }),

  close: (): Promise<void> =>
    invoke<void>('socket_close'),
};
