// packages/pencil/src/lib/ops.ts
//
// Op tracking + Server-Sent Events bus. One op in flight at a time per
// AAP launcher. Subscribers receive: op-start, op-log, op-phase, op-end,
// preview-changed.

import type { ServerResponse } from "node:http";
import type { Op, OpKind, ToolResult } from "./types.ts";

let currentOp: Op | null = null;
const subscribers = new Set<ServerResponse>();

function newOpId(): string {
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function startOp(kind: OpKind, name: string): Op {
  const op: Op = {
    id: newOpId(),
    kind,
    name,
    startedAt: Date.now(),
    child: null,
    pid: null,
    stderrTail: "",
  };
  currentOp = op;
  broadcastEvent("op-start", {
    id: op.id,
    kind: op.kind,
    name: op.name,
    startedAt: op.startedAt,
  });
  return op;
}

export function endOp(op: Op, result: { ok: boolean; code: number }): void {
  broadcastEvent("op-end", {
    id: op.id,
    kind: op.kind,
    name: op.name,
    ok: result.ok,
    code: result.code,
    durationMs: Date.now() - op.startedAt,
  });
  if (currentOp && currentOp.id === op.id) currentOp = null;
}

/** Pipe a chunk of stdio through to all SSE subscribers. Also parses for
 *  phase markers — emits `op-phase` when the CLI moves between stages. */
export function emitChunk(op: Op, stream: "stdout" | "stderr", chunk: string): void {
  broadcastEvent("op-log", { id: op.id, stream, chunk });
  const phase = detectPhase(chunk);
  if (phase && phase !== op.phase) {
    op.phase = phase;
    broadcastEvent("op-phase", { id: op.id, phase });
  }
}

const PHASE_RULES: { pattern: RegExp; phase: string }[] = [
  {
    pattern: /Pencil CLI starting|Initializing IPC server|addResource|Initializing editor/i,
    phase: "Booting",
  },
  { pattern: /WebSocket server (?:listening|ready)/i, phase: "Loading editor" },
  {
    pattern: /Running agent with prompt|Starting Claude Agent session/i,
    phase: "Designing",
  },
  { pattern: /Saving|Saved/i, phase: "Saving" },
  { pattern: /Exporting|Exported/i, phase: "Exporting" },
  { pattern: /Done\.?$/m, phase: "Done" },
];

function detectPhase(chunk: string): string | null {
  for (const { pattern, phase } of PHASE_RULES) {
    if (pattern.test(chunk)) return phase;
  }
  return null;
}

export function getCurrentOp(): Op | null {
  return currentOp;
}

/** Returns an MCP errResult-shaped reply if another op is live. */
export function rejectIfBusy(): ToolResult | null {
  if (!currentOp) return null;
  const elapsed = Math.round((Date.now() - currentOp.startedAt) / 1000);
  return {
    isError: true,
    content: [
      {
        type: "text",
        text:
          `Pencil is already running ${currentOp.kind} on "${currentOp.name}" ` +
          `(started ${elapsed}s ago). Cancel it from the panel or wait for it to finish.`,
      },
    ],
  };
}

export function cancelCurrentOp(): string | null {
  if (!currentOp || !currentOp.child) return null;
  const id = currentOp.id;
  try {
    currentOp.child.kill("SIGTERM");
    setTimeout(() => {
      if (currentOp && currentOp.id === id && currentOp.child) {
        try {
          currentOp.child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }, 3000);
    return id;
  } catch {
    return null;
  }
}

// ---- SSE ------------------------------------------------------------------

export function broadcastEvent(event: string, data: Record<string, unknown>): void {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of subscribers) {
    try {
      res.write(frame);
    } catch {
      subscribers.delete(res);
    }
  }
}

export function addSubscriber(res: ServerResponse): void {
  subscribers.add(res);
}
export function removeSubscriber(res: ServerResponse): void {
  subscribers.delete(res);
}
export function endAllSubscribers(): void {
  for (const r of subscribers) {
    try {
      r.end();
    } catch {
      /* already gone */
    }
  }
  subscribers.clear();
}
