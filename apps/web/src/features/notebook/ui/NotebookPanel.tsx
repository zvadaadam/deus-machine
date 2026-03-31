/**
 * NotebookPanel — Displays .ipynb notebook cells and their outputs.
 *
 * Reads the notebook file from {workspacePath}/.context/notebook.ipynb,
 * parses it as a Jupyter notebook, and renders each cell with source code
 * and outputs. Auto-refreshes every 2s via polling.
 *
 * Output types handled:
 * - stream (stdout/stderr)
 * - execute_result (with Out[N] prefix)
 * - error (ename + evalue + traceback)
 * - display_data (text/plain, image/png as base64 img)
 */

import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { match } from "ts-pattern";
import { BookOpen, AlertCircle } from "lucide-react";
import { sendRequest } from "@/platform/ws";

// --- Jupyter notebook types (subset of nbformat v4) ---

interface NotebookCellOutput {
  output_type: "stream" | "execute_result" | "display_data" | "error";
  /** stream outputs */
  name?: "stdout" | "stderr";
  text?: string | string[];
  /** execute_result / display_data */
  data?: Record<string, string | string[]>;
  metadata?: Record<string, unknown>;
  execution_count?: number | null;
  /** error outputs */
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

interface NotebookCell {
  cell_type: "code" | "markdown" | "raw";
  source: string | string[];
  outputs?: NotebookCellOutput[];
  execution_count?: number | null;
  metadata?: Record<string, unknown>;
}

interface NotebookDocument {
  cells: NotebookCell[];
  metadata?: Record<string, unknown>;
  nbformat?: number;
  nbformat_minor?: number;
}

// --- Helpers ---

/** Normalize source/text that can be string or string[] to a single string */
function normalizeText(value: string | string[] | undefined): string {
  if (!value) return "";
  if (Array.isArray(value)) return value.join("");
  return value;
}

/** Determine cell execution status from outputs */
function getCellStatus(cell: NotebookCell): "idle" | "success" | "error" {
  if (!cell.outputs || cell.outputs.length === 0) return "idle";
  const hasError = cell.outputs.some((o) => o.output_type === "error");
  if (hasError) return "error";
  return "success";
}

// --- Sub-components ---

function CellExecutionBadge({
  executionCount,
  status,
}: {
  executionCount: number | null | undefined;
  status: "idle" | "success" | "error";
}) {
  const label = executionCount != null ? `In [${executionCount}]:` : "In [ ]:";
  return (
    <span
      className={
        status === "error"
          ? "text-destructive font-mono text-xs"
          : "text-muted-foreground font-mono text-xs"
      }
    >
      {label}
    </span>
  );
}

function StreamOutput({ output }: { output: NotebookCellOutput }) {
  const text = normalizeText(output.text);
  if (!text) return null;
  const isStderr = output.name === "stderr";
  return (
    <pre
      className={`max-h-96 overflow-auto font-mono text-xs leading-relaxed break-words whitespace-pre-wrap ${
        isStderr ? "text-destructive/80" : "text-foreground/80"
      }`}
    >
      {text}
    </pre>
  );
}

function ExecuteResultOutput({ output }: { output: NotebookCellOutput }) {
  const text = normalizeText(output.data?.["text/plain"]);
  if (!text) return null;
  const count = output.execution_count;
  return (
    <div className="flex gap-2">
      <span className="text-muted-foreground flex-shrink-0 font-mono text-xs">
        {count != null ? `Out[${count}]:` : "Out:"}
      </span>
      <pre className="text-foreground/80 max-h-96 min-w-0 flex-1 overflow-auto font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
        {text}
      </pre>
    </div>
  );
}

function DisplayDataOutput({ output }: { output: NotebookCellOutput }) {
  const data = output.data;
  if (!data) return null;

  // Prefer image/png rendering
  const imagePng = normalizeText(data["image/png"]);
  if (imagePng) {
    return (
      <div className="py-1">
        <img
          src={`data:image/png;base64,${imagePng.trim()}`}
          alt="Cell output"
          className="max-w-full rounded-md"
        />
      </div>
    );
  }

  // Fall back to text/plain
  const text = normalizeText(data["text/plain"]);
  if (text) {
    return (
      <pre className="text-foreground/80 max-h-96 overflow-auto font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
        {text}
      </pre>
    );
  }

  return null;
}

/** Strip ANSI escape codes from traceback strings */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function ErrorOutput({ output }: { output: NotebookCellOutput }) {
  return (
    <div className="bg-destructive/10 rounded-md p-3">
      <div className="flex items-center gap-2">
        <AlertCircle className="text-destructive h-3.5 w-3.5 flex-shrink-0" />
        <span className="text-destructive font-mono text-xs font-medium">
          {output.ename}: {output.evalue}
        </span>
      </div>
      {output.traceback && output.traceback.length > 0 && (
        <pre className="text-destructive/70 mt-2 max-h-96 overflow-auto font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
          {stripAnsi(output.traceback.join("\n"))}
        </pre>
      )}
    </div>
  );
}

function CellOutputRenderer({ output }: { output: NotebookCellOutput }) {
  return match(output)
    .with({ output_type: "stream" }, (o) => <StreamOutput output={o} />)
    .with({ output_type: "execute_result" }, (o) => <ExecuteResultOutput output={o} />)
    .with({ output_type: "display_data" }, (o) => <DisplayDataOutput output={o} />)
    .with({ output_type: "error" }, (o) => <ErrorOutput output={o} />)
    .exhaustive();
}

function NotebookCellView({ cell, index }: { cell: NotebookCell; index: number }) {
  const source = normalizeText(cell.source);
  const status = getCellStatus(cell);
  const isCode = cell.cell_type === "code";
  const outputs = cell.outputs ?? [];

  // Skip completely empty cells (no source and no outputs)
  if (!source.trim() && outputs.length === 0) return null;

  return (
    <div className="border-border/30 border-b last:border-b-0">
      {/* Source */}
      <div className="px-4 pt-3 pb-2">
        <div className="mb-1.5 flex items-center gap-2">
          {isCode && <CellExecutionBadge executionCount={cell.execution_count} status={status} />}
          {cell.cell_type === "markdown" && (
            <span className="text-muted-foreground font-mono text-xs">Markdown</span>
          )}
        </div>
        {source.trim() && (
          <pre className="bg-muted/30 max-h-64 overflow-auto rounded-md p-3 font-mono text-xs leading-relaxed">
            {source}
          </pre>
        )}
      </div>

      {/* Outputs */}
      {outputs.length > 0 && (
        <div className="space-y-2 px-4 pb-3 pl-6">
          {outputs.map((output, oi) => (
            <CellOutputRenderer key={`${index}-out-${oi}`} output={output} />
          ))}
        </div>
      )}
    </div>
  );
}

// --- Main component ---

interface NotebookPanelProps {
  workspaceId: string;
  sessionStatus?: string | null;
}

export function NotebookPanel({ workspaceId, sessionStatus }: NotebookPanelProps) {
  /** Relative path within the workspace to the notebook file */
  const notebookRelativePath = ".context/notebook.ipynb";

  const readNotebook = useCallback(async (): Promise<NotebookDocument | null> => {
    try {
      const data = await sendRequest<{ content: string | null }>("fileContent", {
        workspaceId,
        path: notebookRelativePath,
      });
      if (!data.content) return null;
      return JSON.parse(data.content) as NotebookDocument;
    } catch {
      // File not found, binary, or invalid JSON — treat as empty
      return null;
    }
  }, [workspaceId]);

  const { data: notebook } = useQuery({
    queryKey: ["notebook", workspaceId, notebookRelativePath],
    queryFn: readNotebook,
    refetchInterval: sessionStatus === "working" ? 2000 : false,
    staleTime: 1000,
    refetchOnWindowFocus: false,
  });

  const cells = notebook?.cells ?? [];
  const hasCells = cells.length > 0;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header bar — matches vibrancy-panel style from TerminalPanel */}
      <div className="vibrancy-panel border-border/40 flex h-9 flex-shrink-0 items-center gap-2 border-b px-4">
        <BookOpen className="text-muted-foreground h-4 w-4" />
        <span className="text-sm font-medium">Notebook</span>
        {hasCells && (
          <span className="text-muted-foreground ml-auto text-xs tabular-nums">
            {cells.length} {cells.length === 1 ? "cell" : "cells"}
          </span>
        )}
      </div>

      {/* Content */}
      {hasCells ? (
        <div className="flex-1 overflow-y-auto py-1">
          {cells.map((cell, i) => (
            <NotebookCellView key={i} cell={cell} index={i} />
          ))}
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
          <div className="bg-muted/30 flex h-10 w-10 items-center justify-center rounded-xl">
            <BookOpen className="text-muted-foreground/50 h-5 w-5" />
          </div>
          <div className="space-y-1.5">
            <p className="text-foreground text-sm font-medium">No notebook cells yet</p>
            <p className="text-muted-foreground max-w-[260px] text-xs leading-relaxed">
              The agent's notebook will appear here when it starts experimenting.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
