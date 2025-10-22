/**
 * Socket Client - Tauri Platform Wrapper
 *
 * Thin wrapper around Tauri invoke commands for socket operations.
 * For high-level session operations, use src/services/socket.ts (UnixSocketService)
 */

import { listen } from '../invoke';
import { socketCommands } from '../commands/socket';

export class SocketClient {
  /**
   * Connect to Unix socket
   */
  connect(path: string): Promise<void> {
    return socketCommands.connect(path);
  }

  /**
   * Send data through socket
   */
  send(data: string): Promise<void> {
    return socketCommands.send(data);
  }

  /**
   * Close socket connection
   */
  close(): Promise<void> {
    return socketCommands.close();
  }

  /**
   * Listen for socket messages
   */
  onMessage(callback: (data: string) => void): Promise<() => void> {
    return listen('socket_message', (event) => {
      callback(event.payload as string);
    });
  }
}
