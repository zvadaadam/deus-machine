import { describe, it, expect } from 'vitest';
import {
  isValidJsonString,
  prepareMessageContent,
  parseMessageContent,
  detectControlCharacters,
} from '../../lib/message-sanitizer';

describe('isValidJsonString', () => {
  it('returns true for a normal string', () => {
    expect(isValidJsonString('hello')).toBe(true);
  });

  it('returns true for an empty string', () => {
    expect(isValidJsonString('')).toBe(true);
  });

  it('returns false for a number', () => {
    expect(isValidJsonString(42 as unknown as string)).toBe(false);
  });

  it('returns false for null', () => {
    expect(isValidJsonString(null as unknown as string)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isValidJsonString(undefined as unknown as string)).toBe(false);
  });

  it('handles unicode strings', () => {
    expect(isValidJsonString('hello \u00e9\u00e8\u00ea \u{1F600}')).toBe(true);
  });
});

describe('prepareMessageContent', () => {
  it('succeeds for a simple message object', () => {
    const result = prepareMessageContent({ type: 'text', text: 'hello' });
    expect(result.success).toBe(true);
    expect(result.content).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  it('succeeds for deeply nested objects', () => {
    const nested = { a: { b: { c: { d: 'deep' } } } };
    const result = prepareMessageContent(nested);
    expect(result.success).toBe(true);
  });

  it('fails for circular references', () => {
    const obj: Record<string, unknown> = { key: 'value' };
    obj.self = obj;
    const result = prepareMessageContent(obj);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Stringify failed');
  });

  it('round-trips content correctly', () => {
    const data = { type: 'text', text: 'hello', count: 42 };
    const result = prepareMessageContent(data);
    expect(result.success).toBe(true);
    const parsed = JSON.parse(result.content!);
    expect(parsed).toEqual(data);
  });
});

describe('parseMessageContent', () => {
  it('succeeds for valid JSON', () => {
    const result = parseMessageContent('{"key":"value"}');
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ key: 'value' });
  });

  it('returns parsed data with correct structure', () => {
    const result = parseMessageContent('[1, 2, 3]');
    expect(result.success).toBe(true);
    expect(result.data).toEqual([1, 2, 3]);
  });

  it('fails for non-string input with type error', () => {
    const result = parseMessageContent(123 as unknown as string);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not a string');
    expect(result.error).toContain('number');
  });

  it('fails for empty string', () => {
    const result = parseMessageContent('');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Content is empty');
  });

  it('fails for whitespace-only string', () => {
    const result = parseMessageContent('   ');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Content is empty');
  });

  it('fails for invalid JSON with error message', () => {
    const result = parseMessageContent('{invalid}');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(typeof result.error).toBe('string');
  });
});

describe('detectControlCharacters', () => {
  it('detects null byte (\\x00)', () => {
    const result = detectControlCharacters('hello\x00world');
    expect(result.hasIssues).toBe(true);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('detects SOH control character (\\x01)', () => {
    const result = detectControlCharacters('test\x01data');
    expect(result.hasIssues).toBe(true);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('returns no issues for clean string', () => {
    const result = detectControlCharacters('hello world! 123 @#$');
    expect(result.hasIssues).toBe(false);
    expect(result.issues).toEqual([]);
  });

  it('handles non-string input gracefully', () => {
    const result = detectControlCharacters(42 as unknown as string);
    expect(result.hasIssues).toBe(false);
    expect(result.issues).toEqual([]);
  });
});
