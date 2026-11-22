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

  has(toolName: string): boolean {
    return this.renderers.has(toolName);
  }

  /**
   * Set the default renderer (fallback for unknown tools)
   */
  setDefault(renderer: ToolRenderer): void {
    this.defaultRenderer = renderer;
  }

  /**
   * Get renderer for a tool (returns default if not found). An MCP tool comes
   * by its own name (`toolCardName`), whichever harness called it.
   */
  getRenderer(toolName: string): ToolRenderer {
    const renderer = this.renderers.get(toolName);
    if (renderer) return renderer;

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
