/**
 * Tool Registry Initialization
 *
 * Registers all tool renderers on app startup.
 * Import this file early in your app to ensure tools are registered.
 */

import { toolRegistry } from './ToolRegistry';
import {
  DefaultToolRenderer,
  EditToolRenderer,
  WriteToolRenderer,
  BashToolRenderer,
  ReadToolRenderer,
  GrepToolRenderer,
  TodoWriteToolRenderer,
  GlobToolRenderer,
  BashOutputToolRenderer,
} from './renderers';

/**
 * Initialize all tool renderers
 */
export function registerAllTools() {
  // Set default renderer (fallback for unknown tools)
  toolRegistry.setDefault(DefaultToolRenderer);

  // Register specific tool renderers
  toolRegistry.register('Edit', EditToolRenderer);
  toolRegistry.register('Write', WriteToolRenderer);
  toolRegistry.register('Bash', BashToolRenderer);
  toolRegistry.register('Read', ReadToolRenderer);
  toolRegistry.register('Grep', GrepToolRenderer);
  toolRegistry.register('TodoWrite', TodoWriteToolRenderer);
  toolRegistry.register('Glob', GlobToolRenderer);
  toolRegistry.register('BashOutput', BashOutputToolRenderer);

  // Additional tools can be registered here:
  // toolRegistry.register('WebFetch', WebFetchToolRenderer);
  // toolRegistry.register('WebSearch', WebSearchToolRenderer);
  // toolRegistry.register('Task', TaskToolRenderer);

  if (import.meta.env.DEV) {
    const stats = toolRegistry.getStats();
    console.log('[ToolRegistry] Initialization complete:', stats);
  }
}

// Auto-initialize on import
registerAllTools();
