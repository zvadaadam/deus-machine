// sidecar/db/message-sanitizer.ts
// Handles sanitization of message content to prevent JSON parsing errors
// caused by control characters in tool outputs.
// Copied from backend/src/lib/message-sanitizer.ts

export function isValidJsonString(str: string): boolean {
  if (typeof str !== 'string') return false;
  try {
    const stringified = JSON.stringify(str);
    const parsed = JSON.parse(stringified);
    return parsed === str;
  } catch {
    return false;
  }
}

export function prepareMessageContent(messageData: unknown): { success: boolean; content?: string; error?: string } {
  try {
    const stringified = JSON.stringify(messageData);

    try {
      const parsed = JSON.parse(stringified);
      const reStringified = JSON.stringify(parsed);

      if (stringified !== reStringified) {
        return { success: false, error: 'Content lost integrity during round-trip serialization' };
      }

      return { success: true, content: stringified };
    } catch (parseError: any) {
      return { success: false, error: `Parse validation failed: ${parseError.message}` };
    }
  } catch (stringifyError: any) {
    return { success: false, error: `Stringify failed: ${stringifyError.message}` };
  }
}

export function parseMessageContent(content: string, messageId = 'unknown'): { success: boolean; data?: any; error?: string; position?: number } {
  if (typeof content !== 'string') {
    return { success: false, error: `Content is not a string (type: ${typeof content})` };
  }

  if (!content.trim()) {
    return { success: false, error: 'Content is empty' };
  }

  try {
    const parsed = JSON.parse(content);
    return { success: true, data: parsed };
  } catch (error: any) {
    const errorMessage = error.message;
    const position = error.message.match(/position (\d+)/)?.[1];

    console.error('[MESSAGE-SANITIZER] JSON parse error:', {
      messageId,
      error: errorMessage,
      position: position ? parseInt(position) : undefined,
      contentLength: content.length,
      contentPreview: content.substring(0, 200),
    });

    return {
      success: false,
      error: errorMessage,
      position: position ? parseInt(position) : undefined,
    };
  }
}

export function detectControlCharacters(str: string): { hasIssues: boolean; issues: string[] } {
  if (typeof str !== 'string') {
    return { hasIssues: false, issues: [] };
  }

  const issues: string[] = [];

  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/.test(str)) {
    issues.push('Contains control characters (0x00-0x1F, 0x7F-0x9F)');
  }

  if (/\\[^"\\/bfnrtu]/.test(str)) {
    issues.push('Contains potentially problematic escape sequences');
  }

  return { hasIssues: issues.length > 0, issues };
}
