/**
 * Socket Commands - Tauri Platform Wrapper
 *
 * Wrappers for Tauri invoke commands related to socket operations
 */

import { invoke } from '@tauri-apps/api/core';

export const socketCommands = {
  connect: (path: string) =>
    invoke('socket_connect', { path }),

  send: (data: string) =>
    invoke('socket_send', { data }),

  close: () =>
    invoke('socket_close'),
};
