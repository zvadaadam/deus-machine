/**
 * Tool Renderer Registry
 *
 * Central registry for tool-specific renderers.
 *
 * Usage:
 *   toolRegistry.register('Edit', EditToolRenderer);
 *   const Renderer = toolRegistry.getRenderer('Edit');
 */

import type { ToolRenderer } from "../chat-types";

class ToolRendererRegistry {
  private renderers = new Map<string, ToolRenderer>();
  private defaultRenderer: ToolRenderer | null = null;

  /**
   * Register a tool renderer
   */
  register(toolName: string, renderer: ToolRenderer): void {
    this.renderers.set(toolName, renderer);
  }

  /**
   * Set the default renderer (fallback for unknown tools)
   */
  setDefault(renderer: ToolRenderer): void {
    this.defaultRenderer = renderer;
  }

  /**
   * Normalize a tool name by stripping MCP server prefixes.
   * "mcp__hive__BrowserSnapshot" → "BrowserSnapshot"
   */
  private normalizeName(toolName: string): string {
    if (toolName.startsWith("mcp__")) {
      const parts = toolName.split("__");
      if (parts.length >= 3) {
        return parts.slice(2).join("__");
      }
    }
    return toolName;
  }

  /**
   * Get renderer for a tool (returns default if not found).
   * Handles MCP server prefixes: "mcp__hive__BrowserSnapshot" → "BrowserSnapshot"
   */
  getRenderer(toolName: string): ToolRenderer {
    // Direct match first (built-in tools like Edit, Bash, Read)
    const renderer = this.renderers.get(toolName);
    if (renderer) return renderer;

    // Try with MCP prefix stripped
    const bareName = this.normalizeName(toolName);
    if (bareName !== toolName) {
      const mcpRenderer = this.renderers.get(bareName);
      if (mcpRenderer) return mcpRenderer;
    }

    // Return default or minimal fallback
    if (this.defaultRenderer) {
      if (import.meta.env.DEV) {
        console.warn(`[ToolRegistry] No renderer for "${toolName}", using default`);
      }
      return this.defaultRenderer;
    }

    console.error(`[ToolRegistry] No renderer found for "${toolName}" and no default set!`);
    return () => (
      <div className="bg-muted/50 text-muted-foreground rounded-md p-2 text-sm">
        <strong>No renderer available for tool: {toolName}</strong>
      </div>
    );
  }
}

// Export singleton instance
export const toolRegistry = new ToolRendererRegistry();
