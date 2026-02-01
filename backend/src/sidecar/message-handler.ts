import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { prepareMessageContent } from '../lib/message-sanitizer';

export class MessageHandler {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  handle(message: any): string | null {
    if (message.type === 'keep_alive') {
      return 'keep_alive';
    }

    if (message.type === 'result' && message.session_id) {
      this._handleResult(message);
      return 'result';
    }

    if (message.type === 'init_status') {
      console.log(`[SIDECAR] Initialized: ${message.success}`);
      return 'init_status';
    }

    if (message.type === 'control_response') {
      console.log('[SIDECAR] Control response received');
      return 'control_response';
    }

    console.log('[SIDECAR] Unknown message type:', message.type);
    return null;
  }

  private _handleResult(message: any): void {
    const messageId = randomUUID();

    try {
      const prepared = prepareMessageContent(message);

      if (!prepared.success) {
        console.error(`[SIDECAR] Failed to prepare message content: ${prepared.error}`);
        return;
      }

      this.db.prepare(`
        INSERT INTO session_messages (id, session_id, role, content, created_at)
        VALUES (?, ?, 'assistant', ?, datetime('now'))
      `).run(messageId, message.session_id, prepared.content);

      if (message.stop_reason || message.is_final) {
        this.db.prepare(`
          UPDATE sessions SET status = 'idle', updated_at = datetime('now') WHERE id = ?
        `).run(message.session_id);
      }
    } catch (error) {
      console.error('[SIDECAR] Failed to save assistant message:', error);
    }
  }
}
