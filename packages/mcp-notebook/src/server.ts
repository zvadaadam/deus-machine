/**
 * MCP Notebook Server — persistent JavaScript REPL for AI coding agents.
 *
 * Provides a stateful execution context where variables, functions, and
 * imports persist across tool calls. Agents can test functions, explore
 * data, prototype algorithms, and validate API responses.
 *
 * Architecture: Uses node:vm with a persistent Context object. Each
 * notebook_execute call runs code in the same sandbox, so `const x = 42`
 * in one call means `x` is available in the next.
 */

import * as fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PersistentVMContext } from "./vm-context.js";
import { NotebookStore } from "./notebook-store.js";

const cwd = process.env.NOTEBOOK_CWD ?? process.cwd();
const notebookPath = process.env.NOTEBOOK_PATH ?? null;

const vmContext = new PersistentVMContext(cwd);
const store = new NotebookStore(notebookPath ?? undefined);

// Load existing notebook if present
if (notebookPath) {
  try {
    if (fs.existsSync(notebookPath)) {
      store.load(notebookPath);
      console.error(`[mcp-notebook] Loaded ${store.getAllCells().length} cells from ${notebookPath}`);
    }
  } catch (err) {
    console.error(`[mcp-notebook] Failed to load notebook:`, err);
  }
}

const server = new McpServer({
  name: "notebook",
  version: "0.1.0",
});

// --- Tool: notebook_execute ---

server.tool(
  "notebook_execute",
  `Execute JavaScript code in a persistent REPL context.

Variables, functions, and imports persist across executions — assign something in
one cell and use it in the next. Console output (log/warn/error) is captured.
Top-level await is supported. Returns the value of the last expression.

Examples:
  - "const x = 42"  →  x is available in future cells
  - "x * 2"  →  returns 84
  - "await fetch('http://localhost:3000/api/health').then(r => r.json())"
  - "const { readFileSync } = require('fs'); readFileSync('package.json', 'utf8')"
  - "require('./src/utils/config').parseConfig()"  →  test project modules directly`,
  {
    code: z.string().describe("JavaScript code to execute"),
    cell_id: z.string().optional().describe(
      "Optional cell ID. Reusing a cell_id updates and re-executes that cell."
    ),
    timeout_ms: z.number().optional().describe(
      "Execution timeout in milliseconds (default: 30000)"
    ),
  },
  async ({ code, cell_id, timeout_ms }) => {
    const cellId = store.addCell(code, cell_id);
    const result = await vmContext.execute(code, {
      timeout: timeout_ms,
      filename: `cell_${cellId}`,
    });
    store.recordExecution(cellId, result);

    // Auto-save after execution
    if (notebookPath) {
      try {
        store.save();
      } catch (err) {
        console.error("[mcp-notebook] Auto-save failed:", err);
      }
    }

    // Format output for the agent
    const parts: string[] = [];

    if (result.stdout.length > 0) {
      parts.push(result.stdout.join("\n"));
    }
    if (result.stderr.length > 0) {
      parts.push(`[stderr]\n${result.stderr.join("\n")}`);
    }
    if (result.error) {
      parts.push(`[error]\n${result.error}`);
    }
    if (result.result !== null) {
      parts.push(result.result);
    }

    const output = parts.join("\n\n") || "(no output)";
    const header = `Cell [${cellId}] #${store.getCell(cellId)?.executionCount ?? "?"} (${result.durationMs}ms)`;

    return {
      content: [{ type: "text" as const, text: `${header}\n\n${output}` }],
      isError: result.error !== null,
    };
  }
);

// --- Tool: notebook_read ---

server.tool(
  "notebook_read",
  "Read the output of a previously executed cell, or the most recent cell if no ID given.",
  {
    cell_id: z.string().optional().describe(
      "Cell ID to read. If omitted, reads the last executed cell."
    ),
  },
  async ({ cell_id }) => {
    const cell = cell_id ? store.getCell(cell_id) : store.getLastExecutedCell();

    if (!cell) {
      return {
        content: [{
          type: "text" as const,
          text: cell_id ? `Cell '${cell_id}' not found.` : "No cells have been executed yet.",
        }],
        isError: !!cell_id,
      };
    }

    const lines = [
      `Cell [${cell.id}] #${cell.executionCount}`,
      `\n\`\`\`javascript\n${cell.source}\n\`\`\``,
    ];

    if (cell.output) {
      if (cell.output.stdout.length > 0) {
        lines.push(`\nstdout:\n${cell.output.stdout.join("\n")}`);
      }
      if (cell.output.stderr.length > 0) {
        lines.push(`\nstderr:\n${cell.output.stderr.join("\n")}`);
      }
      if (cell.output.error) {
        lines.push(`\nerror:\n${cell.output.error}`);
      }
      if (cell.output.result !== null) {
        lines.push(`\nresult (${cell.output.resultType}):\n${cell.output.result}`);
      }
      lines.push(`\n${cell.output.durationMs}ms`);
    } else {
      lines.push("\n(not yet executed)");
    }

    return {
      content: [{ type: "text" as const, text: lines.join("") }],
    };
  }
);

// --- Tool: notebook_list_cells ---

server.tool(
  "notebook_list_cells",
  "List all cells with their IDs, execution status, and source preview.",
  {},
  async () => {
    const cells = store.getAllCells();
    if (cells.length === 0) {
      return {
        content: [{
          type: "text" as const,
          text: "No cells yet. Use notebook_execute to create one.",
        }],
      };
    }

    const lines = cells.map((c) => {
      const status = c.output?.error ? "error" : c.output ? "ok" : "pending";
      const preview = c.source.replace(/\n/g, " ").slice(0, 80);
      const duration = c.output ? ` (${c.output.durationMs}ms)` : "";
      return `${c.id}  #${c.executionCount}  [${status}]${duration}  ${preview}`;
    });

    // Also list context variables
    const vars = vmContext.listVariables();
    const varSection =
      vars.length > 0
        ? `\n\nContext variables (${vars.length}):\n` +
          vars.map((v) => `  ${v.name}: ${v.type} = ${v.preview}`).join("\n")
        : "\n\nNo user-defined variables.";

    return {
      content: [{
        type: "text" as const,
        text: `${cells.length} cells:\n\n${lines.join("\n")}${varSection}`,
      }],
    };
  }
);

// --- Tool: notebook_inspect ---

server.tool(
  "notebook_inspect",
  `Inspect a variable or expression in the current execution context.
Returns its value, type, and (for objects) property names.

Examples: "x", "myObj.keys", "typeof x"`,
  {
    expression: z.string().describe("Variable name or expression to inspect"),
  },
  async ({ expression }) => {
    const info = await vmContext.inspect(expression);

    const lines = [
      `Expression: ${expression}`,
      `Type: ${info.type}`,
      `Value: ${info.value}`,
    ];

    if (info.properties && info.properties.length > 0) {
      lines.push(
        `\nProperties (${info.properties.length}):`,
        ...info.properties.map((p) => `  ${p}`)
      );
    }

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
      isError: info.type === "error",
    };
  }
);

// --- Tool: notebook_reset ---

server.tool(
  "notebook_reset",
  "Reset the execution context. Clears all variables and state. Optionally clears cell history too.",
  {
    clear_cells: z.boolean().optional().describe(
      "Also clear all cell history (default: false — keeps cells, resets context)"
    ),
  },
  async ({ clear_cells }) => {
    vmContext.reset();
    if (clear_cells) {
      store.clear();
    }

    if (notebookPath) {
      try { store.save(); } catch { /* ignore */ }
    }

    return {
      content: [{
        type: "text" as const,
        text: clear_cells
          ? "Context reset and all cells cleared."
          : "Context reset. Cell history preserved — re-execute cells to restore state.",
      }],
    };
  }
);

// --- Tool: notebook_save ---

server.tool(
  "notebook_save",
  "Save the current notebook to disk as a .ipynb file that can be opened in VS Code or JupyterLab.",
  {
    path: z.string().optional().describe(
      "File path to save to (default: ./notebook.ipynb or NOTEBOOK_PATH env var)"
    ),
  },
  async ({ path: savePath }) => {
    const savedTo = store.save(savePath);
    const cellCount = store.getAllCells().length;

    return {
      content: [{
        type: "text" as const,
        text: `Notebook saved to ${savedTo} (${cellCount} cells)`,
      }],
    };
  }
);

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[mcp-notebook] Server started (cwd: ${cwd}, notebook: ${notebookPath ?? "in-memory"})`
  );
}

main().catch((err) => {
  console.error("[mcp-notebook] Fatal:", err);
  process.exit(1);
});
