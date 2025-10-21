/**
 * Socket Client - Tauri Platform Wrapper
 *
 * Thin wrapper around Tauri invoke commands for socket operations.
 * For high-level session operations, use src/services/socket.ts (UnixSocketService)
 */

import { invoke, listen } from '../invoke';

export class SocketClient {
  /**
   * Connect to Unix socket
   */
  async connect(path: string): Promise<void> {
    return invoke('socket_connect', { path });
  }

  /**
   * Send data through socket
   */
  async send(data: string): Promise<void> {
    return invoke('socket_send', { data });
  }

  /**
   * Close socket connection
   */
  async close(): Promise<void> {
    return invoke('socket_close');
  }

  /**
   * Listen for socket messages
   */
  onMessage(callback: (data: string) => void) {
    return listen('socket_message', (event) => {
      callback(event.payload as string);
    });
  }
}
