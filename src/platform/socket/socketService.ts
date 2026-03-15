/**
 * Socket Service — WebSocket Command Adapter
 *
 * Thin wrapper that sends agent commands (sendMessage, stopSession) via the
 * backend WebSocket query protocol. Replaces the old Unix socket relay that
 * went through Rust IPC.
 *
 * Architecture:
 *   Frontend → WS q:command → Backend → Agent-Server
 *
 * The sendQuery() and cancelQuery() APIs are preserved so existing callers
 * (useSendMessage, useSessionActions) don't need to change.
 */

import { sendCommand, connect, isConnected } from "@/platform/ws";
import type { AgentType } from "@shared/enums";
import { QueryAckResponseSchema } from "@shared/protocol";
import type { QueryAckResponse, QueryOptions } from "@shared/protocol";

// Re-export shared types for downstream consumers
export type { QueryAckResponse, QueryOptions };

/**
 * Socket Service (Singleton)
 *
 * Routes agent commands through the backend WebSocket connection.
 */
class SocketService {
  /**
   * Send agent query via WS q:command sendMessage.
   *
   * The backend receives the command, saves the user message, and forwards
   * to the agent-server. Returns an ACK with { accepted, reason? }.
   */
  async sendQuery(
    sessionId: string,
    prompt: string,
    options: QueryOptions,
    agentType: AgentType = "claude"
  ): Promise<QueryAckResponse> {
    // Ensure WS is connected before sending
    if (!isConnected()) {
      await connect();
    }

    const result = await sendCommand("sendMessage", {
      sessionId,
      content: prompt,
      model: options.model,
      cwd: options.cwd,
      agentType,
      // Pass through all query options the agent-server needs
      maxThinkingTokens: options.maxThinkingTokens,
      maxTurns: options.maxTurns,
      turnId: options.turnId,
      permissionMode: options.permissionMode,
      claudeEnvVars: options.claudeEnvVars,
      ghToken: options.ghToken,
      opendevsEnv: options.opendevsEnv,
      additionalDirectories: options.additionalDirectories,
      chromeEnabled: options.chromeEnabled,
      strictDataPrivacy: options.strictDataPrivacy,
      shouldResetGenerator: options.shouldResetGenerator,
      resume: options.resume,
      resumeSessionAt: options.resumeSessionAt,
    });

    // Map WS command ACK to the QueryAckResponse shape callers expect
    const ackResponse: QueryAckResponse = {
      accepted: result.accepted,
      reason: result.error,
    };

    const parsed = QueryAckResponseSchema.safeParse(ackResponse);
    if (!parsed.success) {
      console.error("[SocketService] Invalid QueryAckResponse:", parsed.error.message);
      return { accepted: false, reason: "Invalid response from backend" };
    }

    if (import.meta.env.DEV) {
      console.log(
        "[SocketService] sendMessage command sent:",
        sessionId.substring(0, 8),
        parsed.data
      );
    }

    return parsed.data;
  }

  /**
   * Cancel an active query via WS q:command stopSession.
   */
  async cancelQuery(sessionId: string, _agentType: AgentType = "claude"): Promise<void> {
    if (!isConnected()) {
      await connect();
    }

    await sendCommand("stopSession", { sessionId });

    if (import.meta.env.DEV) {
      console.log("[SocketService] stopSession command sent:", sessionId.substring(0, 8));
    }
  }

  /**
   * Check if the WS connection is available.
   */
  isConnected(): boolean {
    return isConnected();
  }
}

// Export singleton instance
export const socketService = new SocketService();
