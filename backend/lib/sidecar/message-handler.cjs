/**
 * Sidecar Message Handler
 *
 * Handles different types of messages from the sidecar:
 * - Result messages (saved to database)
 * - Keep-alive messages
 * - Init status messages
 * - Control responses
 *
 * @module sidecar/message-handler
 */

const { randomUUID } = require('crypto');
const { prepareMessageContent } = require('../message-sanitizer.cjs');

/**
 * Message Handler for sidecar messages
 */
class MessageHandler {
  constructor(db) {
    this.db = db;
  }

  /**
   * Handle a message from the sidecar
   * @param {Object} message - The parsed message
   * @returns {string|null} - Message type if recognized, null otherwise
   */
  handle(message) {
    // Keep-alive messages (for health monitoring)
    if (message.type === 'keep_alive') {
      return 'keep_alive';
    }

    // Result messages (saved to database)
    if (message.type === 'result' && message.session_id) {
      this._handleResult(message);
      return 'result';
    }

    // Initialization status
    if (message.type === 'init_status') {
      console.log(`[SIDECAR] ${message.success ? '✅' : '❌'} Initialized: ${message.success}`);
      return 'init_status';
    }

    // Control responses (permission responses)
    if (message.type === 'control_response') {
      console.log('[SIDECAR] 🔐 Control response received');
      return 'control_response';
    }

    // Unknown message type
    console.log('[SIDECAR] ⚠️  Unknown message type:', message.type);
    return null;
  }

  /**
   * Handle result messages
   * @private
   */
  _handleResult(message) {
    const messageId = randomUUID();

    try {
      // Use sanitizer to safely prepare content for storage
      const prepared = prepareMessageContent(message);

      if (!prepared.success) {
        console.error(`[SIDECAR] ❌ Failed to prepare message content: ${prepared.error}`);
        console.error(`   Message ID: ${messageId}, Session: ${message.session_id.substring(0, 8)}`);
        return;
      }

      // Save assistant message to database
      this.db.prepare(`
        INSERT INTO session_messages (id, session_id, role, content, created_at)
        VALUES (?, ?, 'assistant', ?, datetime('now'))
      `).run(messageId, message.session_id, prepared.content);

      console.log(`[SIDECAR] ✅ Saved assistant message for session ${message.session_id.substring(0, 8)}`);

      // Update session status back to idle if this is the final message
      if (message.stop_reason || message.is_final) {
        this.db.prepare(`
          UPDATE sessions
          SET status = 'idle', updated_at = datetime('now')
          WHERE id = ?
        `).run(message.session_id);
      }
    } catch (error) {
      console.error('[SIDECAR] ❌ Failed to save assistant message:', error);
    }
  }
}

module.exports = { MessageHandler };
