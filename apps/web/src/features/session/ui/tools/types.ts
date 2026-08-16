/**
 * The tool card's view model.
 *
 * These are NOT a wire shape and not a cross-process contract: the engine's
 * `ToolPart` is what crosses the wire and lands in `parts.data`. This subtree
 * (22 files of renderers) was written against Anthropic's `tool_use` /
 * `tool_result` block shapes, so `ToolPartBlock.tsx` adapts a `ToolPart` into
 * them at its boundary — `toToolUseBlock` / `toToolResultBlock`.
 *
 * They live here rather than in `shared/types` because that is what they are:
 * one renderer subtree's local dialect, with exactly one adapter feeding it.
 * The shared contract advertises no dialect at all. Converting the renderers to
 * read `ToolPart` directly would delete this file and the adapter with it.
 */

/** A tool invocation, as the renderers expect to read it. */
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, any>;
}

/** A tool's output, as the renderers expect to read it. */
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  // Arrays preserve multi-part MCP tool responses (text + image blocks).
  // Renderers use extractText / extractImage to pull the right piece.
  content: string | Record<string, any> | unknown[];
  is_error?: boolean;
}
