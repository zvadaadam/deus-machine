import { vi, describe, it, expect, beforeEach } from 'vitest';
import { MessageHandler } from '../message-handler';

// Mock the message sanitizer
vi.mock('../../lib/message-sanitizer', () => ({
  prepareMessageContent: vi.fn((msg: any) => ({
    success: true,
    content: JSON.stringify(msg),
  })),
}));

function createMockDb() {
  const runFn = vi.fn();
  const prepareFn = vi.fn(() => ({ run: runFn }));
  return { prepare: prepareFn, _run: runFn };
}

describe('MessageHandler', () => {
  let handler: MessageHandler;
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    mockDb = createMockDb();
    handler = new MessageHandler(mockDb as any);
  });

  describe('handle', () => {
    it('returns "keep_alive" for keepalive messages', () => {
      const result = handler.handle({ type: 'keep_alive', timestamp: Date.now() });
      expect(result).toBe('keep_alive');
    });

    it('does not write to DB for keepalive messages', () => {
      handler.handle({ type: 'keep_alive' });
      expect(mockDb.prepare).not.toHaveBeenCalled();
    });

    it('returns "init_status" for init_status messages', () => {
      const result = handler.handle({ type: 'init_status', success: true });
      expect(result).toBe('init_status');
    });

    it('returns "control_response" for control_response messages', () => {
      const result = handler.handle({ type: 'control_response' });
      expect(result).toBe('control_response');
    });

    it('returns null for unknown message types', () => {
      const result = handler.handle({ type: 'unknown_type' });
      expect(result).toBeNull();
    });

    it('returns null for messages with no type', () => {
      const result = handler.handle({ data: 'some data' });
      expect(result).toBeNull();
    });
  });

  describe('_handleResult', () => {
    it('returns "result" and inserts into DB for result messages', () => {
      const result = handler.handle({
        type: 'result',
        session_id: 'sess-123',
        message: { content: 'hello' },
      });

      expect(result).toBe('result');
      expect(mockDb.prepare).toHaveBeenCalled();

      // Should have INSERT for the message
      const insertCall = mockDb.prepare.mock.calls.find((call: any) =>
        call[0].includes('INSERT INTO session_messages')
      );
      expect(insertCall).toBeDefined();
    });

    it('updates session status to idle when stop_reason is present', () => {
      handler.handle({
        type: 'result',
        session_id: 'sess-123',
        stop_reason: 'end_turn',
      });

      const updateCall = mockDb.prepare.mock.calls.find((call: any) =>
        call[0].includes('UPDATE sessions SET status')
      );
      expect(updateCall).toBeDefined();
    });

    it('updates session status to idle when is_final is true', () => {
      handler.handle({
        type: 'result',
        session_id: 'sess-123',
        is_final: true,
      });

      const updateCall = mockDb.prepare.mock.calls.find((call: any) =>
        call[0].includes('UPDATE sessions SET status')
      );
      expect(updateCall).toBeDefined();
    });

    it('does not update session status when neither stop_reason nor is_final', () => {
      handler.handle({
        type: 'result',
        session_id: 'sess-123',
      });

      const updateCall = mockDb.prepare.mock.calls.find((call: any) =>
        call[0].includes('UPDATE sessions SET status')
      );
      expect(updateCall).toBeUndefined();
    });

    it('skips DB insert when session_id is missing', () => {
      const result = handler.handle({ type: 'result' });
      // Without session_id, the result handler is not triggered
      expect(result).toBeNull();
      expect(mockDb.prepare).not.toHaveBeenCalled();
    });

    it('handles DB errors gracefully without throwing', () => {
      mockDb.prepare.mockImplementation(() => {
        throw new Error('DB connection lost');
      });

      expect(() =>
        handler.handle({
          type: 'result',
          session_id: 'sess-123',
        })
      ).not.toThrow();
    });
  });

  describe('message content preparation', () => {
    it('passes message through prepareMessageContent', async () => {
      const { prepareMessageContent } = await import('../../lib/message-sanitizer');

      handler.handle({
        type: 'result',
        session_id: 'sess-456',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      });

      expect(prepareMessageContent).toHaveBeenCalled();
    });

    it('skips DB insert when prepareMessageContent fails', async () => {
      const { prepareMessageContent } = await import('../../lib/message-sanitizer');
      (prepareMessageContent as any).mockReturnValueOnce({
        success: false,
        error: 'Circular reference',
      });

      handler.handle({
        type: 'result',
        session_id: 'sess-789',
      });

      // prepare should be called for prepareMessageContent, but not for INSERT
      const insertCall = mockDb.prepare.mock.calls.find((call: any) =>
        call[0].includes('INSERT')
      );
      expect(insertCall).toBeUndefined();
    });
  });
});
