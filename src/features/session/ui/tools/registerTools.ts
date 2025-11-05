/**
 * Tool Registry Initialization
 *
 * Registers all tool renderers on app startup.
 * Import this file early in your app to ensure tools are registered.
 */

import { toolRegistry } from "./ToolRegistry";
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
  MultiEditToolRenderer,
  WebFetchToolRenderer,
  WebSearchToolRenderer,
  KillShellToolRenderer,
  TaskToolRenderer,
  LSToolRenderer,
} from "./renderers";

// Idempotency guard - prevent double registration during HMR/dev
let __didRegisterTools = false;

/**
 * Initialize all tool renderers
 * Idempotent - safe to call multiple times
 */
export function registerAllTools() {
  if (__didRegisterTools) return;
  __didRegisterTools = true;

  // Set default renderer (fallback for unknown tools)
  toolRegistry.setDefault(DefaultToolRenderer);

  // Register specific tool renderers
  toolRegistry.register("Edit", EditToolRenderer);
  toolRegistry.register("Write", WriteToolRenderer);
  toolRegistry.register("Bash", BashToolRenderer);
  toolRegistry.register("Read", ReadToolRenderer);
  toolRegistry.register("Grep", GrepToolRenderer);
  toolRegistry.register("TodoWrite", TodoWriteToolRenderer);
  toolRegistry.register("Glob", GlobToolRenderer);
  toolRegistry.register("BashOutput", BashOutputToolRenderer);
  toolRegistry.register("MultiEdit", MultiEditToolRenderer);
  toolRegistry.register("WebFetch", WebFetchToolRenderer);
  toolRegistry.register("WebSearch", WebSearchToolRenderer);
  toolRegistry.register("KillShell", KillShellToolRenderer);
  toolRegistry.register("Task", TaskToolRenderer);
  toolRegistry.register("LS", LSToolRenderer);

  if (import.meta.env.DEV) {
    const stats = toolRegistry.getStats();
    console.log("[ToolRegistry] Initialization complete:", stats);
  }
}

// Auto-initialize on import (idempotent)
registerAllTools();
