/**
 * Notebook Cell Store with .ipynb Persistence
 *
 * Manages an ordered list of cells and serializes to Jupyter's
 * nbformat v4.5 for compatibility with VS Code, JupyterLab, etc.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ExecutionResult } from "./vm-context.js";

export interface Cell {
  id: string;
  source: string;
  executionCount: number;
  output: ExecutionResult | null;
  createdAt: string;
  executedAt: string | null;
}

export class NotebookStore {
  private cells: Cell[] = [];
  private globalCounter = 0;
  private filePath: string | null = null;

  constructor(filePath?: string) {
    this.filePath = filePath ?? null;
  }

  /** Create or update a cell. Returns the cell ID. */
  addCell(source: string, cellId?: string): string {
    const id = cellId ?? crypto.randomUUID().slice(0, 8);

    const existing = this.cells.find((c) => c.id === id);
    if (existing) {
      existing.source = source;
      existing.output = null;
      return id;
    }

    this.cells.push({
      id,
      source,
      executionCount: 0,
      output: null,
      createdAt: new Date().toISOString(),
      executedAt: null,
    });

    return id;
  }

  /** Record the result of executing a cell. */
  recordExecution(cellId: string, result: ExecutionResult): void {
    const cell = this.cells.find((c) => c.id === cellId);
    if (!cell) return;

    this.globalCounter++;
    cell.executionCount = this.globalCounter;
    cell.output = result;
    cell.executedAt = new Date().toISOString();
  }

  getCell(cellId: string): Cell | undefined {
    return this.cells.find((c) => c.id === cellId);
  }

  getAllCells(): Cell[] {
    return [...this.cells];
  }

  getLastExecutedCell(): Cell | undefined {
    const executed = this.cells
      .filter((c) => c.executedAt !== null)
      .sort((a, b) => (b.executedAt! > a.executedAt! ? 1 : -1));
    return executed[0];
  }

  removeCell(cellId: string): boolean {
    const idx = this.cells.findIndex((c) => c.id === cellId);
    if (idx === -1) return false;
    this.cells.splice(idx, 1);
    return true;
  }

  clear(): void {
    this.cells = [];
    this.globalCounter = 0;
  }

  /** Serialize to valid Jupyter .ipynb format (nbformat v4.5). */
  toIpynb(): object {
    const cells = this.cells.map((cell) => {
      const outputs: object[] = [];

      if (cell.output) {
        if (cell.output.stdout.length > 0) {
          outputs.push({
            output_type: "stream",
            name: "stdout",
            text: cell.output.stdout.map((line) => line + "\n"),
          });
        }
        if (cell.output.stderr.length > 0) {
          outputs.push({
            output_type: "stream",
            name: "stderr",
            text: cell.output.stderr.map((line) => line + "\n"),
          });
        }
        if (cell.output.result !== null) {
          outputs.push({
            output_type: "execute_result",
            execution_count: cell.executionCount,
            data: { "text/plain": [cell.output.result] },
            metadata: {},
          });
        }
        if (cell.output.error) {
          const errorLines = cell.output.error.split("\n");
          outputs.push({
            output_type: "error",
            ename: "Error",
            evalue: errorLines[0],
            traceback: errorLines,
          });
        }
      }

      return {
        cell_type: "code",
        execution_count: cell.executionCount || null,
        metadata: {
          id: cell.id,
          executedAt: cell.executedAt,
          durationMs: cell.output?.durationMs ?? null,
        },
        source: cell.source
          .split("\n")
          .map((line, i, arr) => (i < arr.length - 1 ? line + "\n" : line)),
        outputs,
      };
    });

    return {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {
        kernelspec: {
          display_name: "JavaScript (Node.js)",
          language: "javascript",
          name: "javascript",
        },
        language_info: {
          name: "javascript",
          version: process.version,
          mimetype: "application/javascript",
          file_extension: ".js",
        },
        mcp_notebook: {
          version: "0.1.0",
          created: new Date().toISOString(),
        },
      },
      cells,
    };
  }

  /** Save notebook to disk as .ipynb. */
  save(filePath?: string): string {
    const target = filePath ?? this.filePath ?? "notebook.ipynb";
    const dir = path.dirname(target);

    if (dir && dir !== ".") {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(target, JSON.stringify(this.toIpynb(), null, 1), "utf-8");
    this.filePath = target;
    return target;
  }

  /** Load cells from an existing .ipynb file. Restores source but not execution state. */
  load(filePath: string): void {
    const raw = fs.readFileSync(filePath, "utf-8");
    const notebook = JSON.parse(raw);

    if (notebook.nbformat !== 4) {
      throw new Error(`Unsupported notebook format: nbformat ${notebook.nbformat}`);
    }

    this.cells = [];
    this.globalCounter = 0;

    for (const cell of notebook.cells ?? []) {
      if (cell.cell_type !== "code") continue;

      const source = Array.isArray(cell.source) ? cell.source.join("") : cell.source;
      const id = cell.metadata?.id ?? crypto.randomUUID().slice(0, 8);

      this.cells.push({
        id,
        source,
        executionCount: cell.execution_count ?? 0,
        output: null, // Don't restore outputs — re-execute if needed
        createdAt: new Date().toISOString(),
        executedAt: null,
      });

      if ((cell.execution_count ?? 0) > this.globalCounter) {
        this.globalCounter = cell.execution_count;
      }
    }

    this.filePath = filePath;
  }
}
