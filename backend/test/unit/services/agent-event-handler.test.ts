import { beforeEach, describe, expect, it, vi } from 'vitest';

// ============================================================================
// Mocks (vi.hoisted so they're available in vi.mock factories)
// ============================================================================

const {
  mockPersistAssistantMessage,
  mockPersistToolResultMessage,
  mockPersistMessageResult,
  mockPersistMessageCancelled,
  mockPersistSessionStarted,
  mockPersistSessionIdle,
  mockPersistSessionError,
  mockPersistSessionCancelled,
  mockPersistAgentSessionId,
  mockInvalidate,
  mockRelay,
} = vi.hoisted(() => ({
  mockPersistAssistantMessage: vi.fn(() => ({ ok: true, value: 'msg-id' })),
  mockPersistToolResultMessage: vi.fn(() => ({ ok: true, value: 'msg-id' })),
  mockPersistMessageResult: vi.fn(),
  mockPersistMessageCancelled: vi.fn(() => ({ ok: true, value: 'msg-id' })),
  mockPersistSessionStarted: vi.fn(() => ({ ok: true, value: undefined })),
  mockPersistSessionIdle: vi.fn(() => ({ ok: true, value: undefined })),
  mockPersistSessionError: vi.fn(() => ({ ok: true, value: undefined })),
  mockPersistSessionCancelled: vi.fn(() => ({ ok: true, value: undefined })),
  mockPersistAgentSessionId: vi.fn(() => ({ ok: true, value: undefined })),
  mockInvalidate: vi.fn(),
  mockRelay: vi.fn(() => Promise.resolve({ diff: 'ok' })),
}));

vi.mock('../../../src/services/agent-persistence', () => ({
  persistAssistantMessage: mockPersistAssistantMessage,
  persistToolResultMessage: mockPersistToolResultMessage,
  persistMessageResult: mockPersistMessageResult,
  persistMessageCancelled: mockPersistMessageCancelled,
  persistSessionStarted: mockPersistSessionStarted,
  persistSessionIdle: mockPersistSessionIdle,
  persistSessionError: mockPersistSessionError,
  persistSessionCancelled: mockPersistSessionCancelled,
  persistAgentSessionId: mockPersistAgentSessionId,
}));

vi.mock('../../../src/services/query-engine', () => ({
  invalidate: mockInvalidate,
}));

vi.mock('../../../src/services/tool-relay', () => ({
  relay: mockRelay,
}));

// ============================================================================
// Import after mocks
// ============================================================================

import { handleAgentEvent, setRespondToAgent } from '../../../src/services/agent-event-handler';
import type { AgentEvent } from '../../../../shared/agent-events';

// ============================================================================
// Tests
// ============================================================================

describe('handleAgentEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // Session lifecycle
  // ==========================================================================

  describe('session.started', () => {
    const event: AgentEvent = {
      type: 'session.started',
      sessionId: 'sess-1',
      agentType: 'claude',
    };

    it('persists and invalidates on success', () => {
      handleAgentEvent(event);

      expect(mockPersistSessionStarted).toHaveBeenCalledWith(event);
      expect(mockInvalidate).toHaveBeenCalledWith(
        ['workspaces', 'sessions', 'session', 'stats'],
        { sessionIds: ['sess-1'] }
      );
    });

    it('skips invalidation on persistence failure', () => {
      mockPersistSessionStarted.mockReturnValue({ ok: false, error: 'DB error' });

      handleAgentEvent(event);

      expect(mockPersistSessionStarted).toHaveBeenCalledWith(event);
      expect(mockInvalidate).not.toHaveBeenCalled();
    });
  });

  describe('session.idle', () => {
    const event: AgentEvent = {
      type: 'session.idle',
      sessionId: 'sess-1',
      agentType: 'claude',
    };

    it('persists and invalidates workspaces, sessions, session, stats', () => {
      handleAgentEvent(event);

      expect(mockPersistSessionIdle).toHaveBeenCalledWith(event);
      expect(mockInvalidate).toHaveBeenCalledWith(
        ['workspaces', 'sessions', 'session', 'stats'],
        { sessionIds: ['sess-1'] }
      );
    });

    it('skips invalidation on persistence failure', () => {
      mockPersistSessionIdle.mockReturnValue({ ok: false, error: 'DB error' });

      handleAgentEvent(event);

      expect(mockInvalidate).not.toHaveBeenCalled();
    });
  });

  describe('session.error', () => {
    const event: AgentEvent = {
      type: 'session.error',
      sessionId: 'sess-1',
      agentType: 'claude',
      error: 'Rate limit',
      category: 'rate_limit',
    };

    it('persists error details and invalidates', () => {
      handleAgentEvent(event);

      expect(mockPersistSessionError).toHaveBeenCalledWith(event);
      expect(mockInvalidate).toHaveBeenCalledWith(
        ['workspaces', 'sessions', 'session', 'stats'],
        { sessionIds: ['sess-1'] }
      );
    });
  });

  describe('session.cancelled', () => {
    const event: AgentEvent = {
      type: 'session.cancelled',
      sessionId: 'sess-1',
      agentType: 'claude',
    };

    it('persists and invalidates', () => {
      handleAgentEvent(event);

      expect(mockPersistSessionCancelled).toHaveBeenCalledWith(event);
      expect(mockInvalidate).toHaveBeenCalledWith(
        ['workspaces', 'sessions', 'session', 'stats'],
        { sessionIds: ['sess-1'] }
      );
    });
  });

  // ==========================================================================
  // Messages
  // ==========================================================================

  describe('message.assistant', () => {
    const event: AgentEvent = {
      type: 'message.assistant',
      sessionId: 'sess-1',
      agentType: 'claude',
      message: {
        id: 'msg-1',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
      },
      model: 'opus',
    };

    it('persists and invalidates messages + session', () => {
      handleAgentEvent(event);

      expect(mockPersistAssistantMessage).toHaveBeenCalledWith(event);
      expect(mockInvalidate).toHaveBeenCalledWith(
        ['messages', 'session'],
        { sessionIds: ['sess-1'] }
      );
    });

    it('skips invalidation on persistence failure', () => {
      mockPersistAssistantMessage.mockReturnValue({ ok: false, error: 'insert failed' });

      handleAgentEvent(event);

      expect(mockInvalidate).not.toHaveBeenCalled();
    });
  });

  describe('message.tool_result', () => {
    const event: AgentEvent = {
      type: 'message.tool_result',
      sessionId: 'sess-1',
      agentType: 'claude',
      message: {
        id: 'msg-2',
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu-1' }],
      },
    };

    it('persists and invalidates messages + session', () => {
      handleAgentEvent(event);

      expect(mockPersistToolResultMessage).toHaveBeenCalledWith(event);
      expect(mockInvalidate).toHaveBeenCalledWith(
        ['messages', 'session'],
        { sessionIds: ['sess-1'] }
      );
    });
  });

  describe('message.result', () => {
    const event: AgentEvent = {
      type: 'message.result',
      sessionId: 'sess-1',
      agentType: 'claude',
      subtype: 'success',
    };

    it('calls persistMessageResult but does not invalidate', () => {
      handleAgentEvent(event);

      expect(mockPersistMessageResult).toHaveBeenCalledWith(event);
      expect(mockInvalidate).not.toHaveBeenCalled();
    });
  });

  describe('message.cancelled', () => {
    const event: AgentEvent = {
      type: 'message.cancelled',
      sessionId: 'sess-1',
      agentType: 'claude',
    };

    it('persists and invalidates messages, sessions, session, stats', () => {
      handleAgentEvent(event);

      expect(mockPersistMessageCancelled).toHaveBeenCalledWith(event);
      expect(mockInvalidate).toHaveBeenCalledWith(
        ['messages', 'sessions', 'session', 'stats'],
        { sessionIds: ['sess-1'] }
      );
    });
  });

  // ==========================================================================
  // Interaction requests (no DB write, no invalidation)
  // ==========================================================================

  describe('request.opened', () => {
    it('does not persist or invalidate', () => {
      const event: AgentEvent = {
        type: 'request.opened',
        requestId: 'req-1',
        sessionId: 'sess-1',
        agentType: 'claude',
        requestType: 'tool_approval',
        data: { tool: 'bash' },
      };

      handleAgentEvent(event);

      expect(mockInvalidate).not.toHaveBeenCalled();
      // None of the persistence functions should be called
      expect(mockPersistAssistantMessage).not.toHaveBeenCalled();
      expect(mockPersistSessionStarted).not.toHaveBeenCalled();
    });
  });

  describe('request.resolved', () => {
    it('does not persist or invalidate', () => {
      const event: AgentEvent = {
        type: 'request.resolved',
        requestId: 'req-1',
        sessionId: 'sess-1',
      };

      handleAgentEvent(event);

      expect(mockInvalidate).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Tool relay
  // ==========================================================================

  describe('tool.request', () => {
    const event: AgentEvent = {
      type: 'tool.request',
      requestId: 'treq-1',
      sessionId: 'sess-1',
      method: 'getDiff',
      params: { stat: true },
      timeoutMs: 30000,
    };

    it('calls relay() with the event when respondToAgent is registered', () => {
      setRespondToAgent(vi.fn().mockResolvedValue(undefined));
      handleAgentEvent(event);

      expect(mockRelay).toHaveBeenCalledWith(event);
    });

    it('does not persist or invalidate', () => {
      setRespondToAgent(vi.fn().mockResolvedValue(undefined));
      handleAgentEvent(event);

      expect(mockInvalidate).not.toHaveBeenCalled();
      expect(mockPersistAssistantMessage).not.toHaveBeenCalled();
    });

    it('sends result back to agent-server via respondToAgent when relay resolves', async () => {
      const mockRespond = vi.fn().mockResolvedValue(undefined);
      setRespondToAgent(mockRespond);
      mockRelay.mockResolvedValue({ diff: 'file.ts: +10 -5' });

      handleAgentEvent(event);

      // Let the async relay complete
      await vi.waitFor(() => {
        expect(mockRespond).toHaveBeenCalledWith({
          sessionId: 'sess-1',
          requestId: 'treq-1',
          result: { diff: 'file.ts: +10 -5' },
        });
      });
    });

    it('sends error result back to agent-server when relay rejects', async () => {
      const mockRespond = vi.fn().mockResolvedValue(undefined);
      setRespondToAgent(mockRespond);
      mockRelay.mockRejectedValue(new Error('Tool relay timed out'));

      handleAgentEvent(event);

      // Let the async relay complete
      await vi.waitFor(() => {
        expect(mockRespond).toHaveBeenCalledWith({
          sessionId: 'sess-1',
          requestId: 'treq-1',
          result: { error: 'Tool relay timed out' },
        });
      });
    });

    it('does not throw when respondToAgent is not registered', () => {
      setRespondToAgent(null as any);
      // Should not throw — just logs an error
      expect(() => handleAgentEvent(event)).not.toThrow();
    });
  });

  // ==========================================================================
  // Metadata
  // ==========================================================================

  describe('agent.session_id', () => {
    it('persists agent session ID without invalidation', () => {
      const event: AgentEvent = {
        type: 'agent.session_id',
        sessionId: 'sess-1',
        agentSessionId: 'claude-sdk-abc',
      };

      handleAgentEvent(event);

      expect(mockPersistAgentSessionId).toHaveBeenCalledWith(event);
      expect(mockInvalidate).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Exhaustiveness
  // ==========================================================================

  describe('exhaustiveness', () => {
    it('handles all known event types without throwing', () => {
      // This test verifies the .exhaustive() pattern works by calling
      // handleAgentEvent with every event type. If a new event type is added
      // to AgentEvent but not handled, TypeScript compilation will fail.
      const events: AgentEvent[] = [
        { type: 'session.started', sessionId: 's', agentType: 'claude' },
        { type: 'session.idle', sessionId: 's', agentType: 'claude' },
        { type: 'session.error', sessionId: 's', agentType: 'claude', error: 'e', category: 'internal' },
        { type: 'session.cancelled', sessionId: 's', agentType: 'claude' },
        { type: 'message.assistant', sessionId: 's', agentType: 'claude', message: { id: 'm', role: 'assistant', content: [] } },
        { type: 'message.tool_result', sessionId: 's', agentType: 'claude', message: { id: 'm', role: 'user', content: [] } },
        { type: 'message.result', sessionId: 's', agentType: 'claude', subtype: 'success' },
        { type: 'message.cancelled', sessionId: 's', agentType: 'claude' },
        { type: 'request.opened', requestId: 'r', sessionId: 's', agentType: 'claude', requestType: 'tool_approval', data: {} },
        { type: 'request.resolved', requestId: 'r', sessionId: 's' },
        { type: 'tool.request', requestId: 'r', sessionId: 's', method: 'm', params: {}, timeoutMs: 1000 },
        { type: 'agent.session_id', sessionId: 's', agentSessionId: 'a' },
      ];

      for (const event of events) {
        expect(() => handleAgentEvent(event)).not.toThrow();
      }
    });
  });
});
