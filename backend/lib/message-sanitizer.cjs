/**
 * Message Content Sanitizer
 *
 * Handles sanitization of message content to prevent JSON parsing errors
 * caused by control characters in tool outputs.
 *
 * The problem: Tool results from Claude CLI can contain unescaped control
 * characters (especially from terminal output, test results, etc.) that
 * can cause "BAD CONTROL CHARACTER IN STRING LITERAL" errors when parsing.
 *
 * The solution: We don't actually need to "sanitize" since JSON.stringify()
 * already handles escaping properly. Instead, we add validation and better
 * error handling to catch edge cases.
 */

/**
 * Validates that a string can be safely JSON stringified and parsed
 * @param {string} str - String to validate
 * @returns {boolean} - True if safe to use
 */
function isValidJsonString(str) {
  if (typeof str !== 'string') return false;
  try {
    // Try to stringify and parse to ensure round-trip safety
    const stringified = JSON.stringify(str);
    const parsed = JSON.parse(stringified);
    return parsed === str;
  } catch {
    return false;
  }
}

/**
 * Safely prepares message content for database storage
 *
 * This function ensures that message content (which may contain tool outputs
 * with control characters) is properly handled:
 *
 * 1. Uses JSON.stringify() which automatically escapes control characters
 * 2. Validates the result can be round-tripped (stringify → parse → stringify)
 * 3. Provides detailed error information if validation fails
 *
 * @param {any} messageData - The message data to store (typically {message: {...}})
 * @returns {{success: boolean, content?: string, error?: string}} Result object
 */
function prepareMessageContent(messageData) {
  try {
    // First, stringify the message data
    // JSON.stringify automatically escapes control characters:
    // \n → \\n, \t → \\t, \r → \\r, etc.
    const stringified = JSON.stringify(messageData);

    // Validate that it can be parsed back correctly
    try {
      const parsed = JSON.parse(stringified);

      // Verify round-trip integrity
      const reStringified = JSON.stringify(parsed);
      if (stringified !== reStringified) {
        return {
          success: false,
          error: 'Content lost integrity during round-trip serialization'
        };
      }

      return {
        success: true,
        content: stringified
      };
    } catch (parseError) {
      // This should never happen if JSON.stringify() worked correctly
      return {
        success: false,
        error: `Parse validation failed: ${parseError.message}`
      };
    }
  } catch (stringifyError) {
    // This can happen with circular references or non-serializable values
    return {
      success: false,
      error: `Stringify failed: ${stringifyError.message}`
    };
  }
}

/**
 * Safely parses message content from the database
 *
 * Adds better error handling and logging when JSON.parse fails.
 *
 * @param {string} content - The content string from the database
 * @param {string} [messageId] - Optional message ID for error logging
 * @returns {{success: boolean, data?: any, error?: string, position?: number}} Result object
 */
function parseMessageContent(content, messageId = 'unknown') {
  if (typeof content !== 'string') {
    return {
      success: false,
      error: `Content is not a string (type: ${typeof content})`
    };
  }

  if (!content.trim()) {
    return {
      success: false,
      error: 'Content is empty'
    };
  }

  try {
    const parsed = JSON.parse(content);
    return {
      success: true,
      data: parsed
    };
  } catch (error) {
    // Extract error details for debugging
    const errorMessage = error.message;
    const position = error.message.match(/position (\d+)/)?.[1];

    // Log detailed error information
    console.error('[MESSAGE-SANITIZER] ❌ JSON parse error:', {
      messageId,
      error: errorMessage,
      position: position ? parseInt(position) : undefined,
      contentLength: content.length,
      contentPreview: content.substring(0, 200),
      contextAroundError: position ? content.substring(
        Math.max(0, parseInt(position) - 50),
        Math.min(content.length, parseInt(position) + 50)
      ) : undefined
    });

    return {
      success: false,
      error: errorMessage,
      position: position ? parseInt(position) : undefined
    };
  }
}

/**
 * Detects if content contains problematic control characters
 *
 * Note: JSON.stringify() should handle all of these, but this function
 * can be used for diagnostics.
 *
 * @param {string} str - String to check
 * @returns {{hasIssues: boolean, issues: string[]}} Detection result
 */
function detectControlCharacters(str) {
  if (typeof str !== 'string') {
    return { hasIssues: false, issues: [] };
  }

  const issues = [];

  // Check for various control characters
  // Control characters are 0x00-0x1F and 0x7F-0x9F
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/.test(str)) {
    issues.push('Contains control characters (0x00-0x1F, 0x7F-0x9F)');
  }

  // Check for literal backslash sequences that might cause issues
  if (/\\[^"\\/bfnrtu]/.test(str)) {
    issues.push('Contains potentially problematic escape sequences');
  }

  return {
    hasIssues: issues.length > 0,
    issues
  };
}

module.exports = {
  prepareMessageContent,
  parseMessageContent,
  isValidJsonString,
  detectControlCharacters
};
