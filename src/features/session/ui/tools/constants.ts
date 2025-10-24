/**
 * Tool Renderer Constants
 *
 * Shared constants for consistent tool behavior across renderers
 */

/**
 * Tools that should be expanded by default
 *
 * These are typically user-initiated actions that modify files or execute commands.
 * Users want to see the results immediately without clicking.
 *
 * Examples: Edit, Write, Bash, MultiEdit
 */
export const EXPANDED_BY_DEFAULT = new Set([
  'Edit',
  'Write',
  'Bash',
  'MultiEdit',
  'NotebookEdit',
]);

/**
 * Tools that should be collapsed by default
 *
 * These are typically information queries or reads that can be large.
 * Users can expand them if they want to see details.
 *
 * Examples: Read, Grep, Glob, WebFetch, WebSearch
 */
export const COLLAPSED_BY_DEFAULT = new Set([
  'Read',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'BashOutput',
  'LS',
]);

/**
 * Helper to determine if a tool should be expanded by default
 */
export function shouldExpandByDefault(toolName: string): boolean {
  // Unknown tools default to collapsed for safety
  return EXPANDED_BY_DEFAULT.has(toolName);
}
