/**
 * Tool Renderer Registry
 *
 * Central registry for tool-specific renderers using the Registry Pattern.
 * Allows dynamic registration and retrieval of tool renderers.
 *
 * Usage:
 *   toolRegistry.register('Edit', EditToolRenderer);
 *   const Renderer = toolRegistry.getRenderer('Edit');
 *
 * Benefits:
 *   - Extensible: Add new tools without modifying core code
 *   - Type-safe: Full TypeScript support
 *   - Discoverable: Can list all registered tools
 */

import type { ToolRenderer } from "../chat-types";

class ToolRendererRegistry {
  private renderers = new Map<string, ToolRenderer>();
  private defaultRenderer: ToolRenderer | null = null;

  /**
   * Register a tool renderer
   */
  register(toolName: string, renderer: ToolRenderer): void {
    if (!toolName || typeof toolName !== "string") {
      console.error("[ToolRegistry] Invalid tool name:", toolName);
      return;
    }

    if (!renderer) {
      console.error("[ToolRegistry] Invalid renderer for tool:", toolName);
      return;
    }

    this.renderers.set(toolName, renderer);

    if (import.meta.env.DEV) {
      console.log(`[ToolRegistry] ✓ Registered renderer for: ${toolName}`);
    }
  }

  /**
   * Register multiple tool renderers at once
   */
  registerBatch(tools: Record<string, ToolRenderer>): void {
    Object.entries(tools).forEach(([name, renderer]) => {
      this.register(name, renderer);
    });
  }

  /**
   * Set the default renderer (fallback for unknown tools)
   */
  setDefault(renderer: ToolRenderer): void {
    this.defaultRenderer = renderer;

    if (import.meta.env.DEV) {
      console.log("[ToolRegistry] ✓ Set default renderer");
    }
  }

  /**
   * Get renderer for a tool (returns default if not found)
   */
  getRenderer(toolName: string): ToolRenderer {
    const renderer = this.renderers.get(toolName);

    if (renderer) {
      return renderer;
    }

    // Return default or throw error
    if (this.defaultRenderer) {
      if (import.meta.env.DEV) {
        console.warn(`[ToolRegistry] No renderer for "${toolName}", using default`);
      }
      return this.defaultRenderer;
    }

    // No default set - this shouldn't happen in production
    console.error(`[ToolRegistry] No renderer found for "${toolName}" and no default set!`);

    // Return a minimal fallback to prevent crashes
    return () => (
      <div className="bg-destructive/10 text-destructive rounded p-2 text-sm">
        <strong>⚠️ No renderer available for tool: {toolName}</strong>
      </div>
    );
  }

  /**
   * Check if tool has a registered renderer
   */
  hasRenderer(toolName: string): boolean {
    return this.renderers.has(toolName);
  }

  /**
   * Get all registered tool names
   */
  getRegisteredTools(): string[] {
    return Array.from(this.renderers.keys()).sort();
  }

  /**
   * Get registry statistics
   */
  getStats() {
    return {
      totalRenderers: this.renderers.size,
      tools: this.getRegisteredTools(),
      hasDefault: this.defaultRenderer !== null,
    };
  }

  /**
   * Clear all registrations (useful for testing)
   */
  clear(): void {
    this.renderers.clear();
    this.defaultRenderer = null;

    if (import.meta.env.DEV) {
      console.log("[ToolRegistry] Cleared all renderers");
    }
  }
}

// Export singleton instance
export const toolRegistry = new ToolRendererRegistry();

// Log registry info in development
if (import.meta.env.DEV) {
  console.log("[ToolRegistry] Initialized tool renderer registry");

  // Make it accessible from browser console for debugging
  if (typeof window !== "undefined") {
    (window as any).__toolRegistry = toolRegistry;
  }
}
