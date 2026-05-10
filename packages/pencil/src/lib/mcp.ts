// packages/pencil/src/lib/mcp.ts
//
// MCP tool surface. Three lightweight workspace tools live here; the
// heavy lifting (batch_design, get_editor_state, snapshot_layout, …) is
// the bundled MCP binary's tool surface, forwarded through callBinaryTool
// against the live iframe editor. Every design op the agent makes is
// visible on the canvas in real time — no CLI subprocesses, no
// blackbox 30–90s waits.

import { APP_NAME, APP_VERSION } from "./config.ts";
import { listBinaryTools, callBinaryTool } from "./mcp-binary.ts";
import {
  penPathFor,
  setActivePen,
  listAllDesigns,
  resolvePenPath,
  getActivePen,
  safePenName,
} from "./designs.ts";
import * as fs from "node:fs";
import { notifyEditor, pushFileUpdate } from "./ipc-host.ts";
import { broadcastEvent } from "./ops.ts";
import type { Context, ToolDef, ToolResult } from "./types.ts";

// ---- Result helpers -------------------------------------------------------

function okResult(payload: string | Record<string, unknown>): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: typeof payload === "object" ? payload : undefined,
  };
}

function errResult(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

// ---- Tool input shapes ----------------------------------------------------

interface OpenArgs {
  file?: string;
  name?: string;
}
interface NewArgs {
  name?: string;
}

// ---- Tools ----------------------------------------------------------------

export const TOOLS: ToolDef[] = [
  {
    name: "pencil_list_designs",
    description:
      'List every .pen design in this workspace — both files the user has in their repo (anywhere under <workspace>) and agent-generated designs in <workspace>/.pencil/designs/. Use when the user references a design without naming it ("the login screen"), or to confirm a path exists before opening it. Filesystem-only — fast, no canvas needed.',
    inputSchema: { type: "object", properties: {} },
    async run(_args, ctx: Context): Promise<ToolResult> {
      const designs = listAllDesigns(ctx);
      if (designs.length === 0) {
        return okResult({
          designs: [],
          message:
            "No .pen designs in this workspace. Use pencil_new to create a blank canvas, then design with batch_design ops.",
        });
      }
      return okResult({
        designs: designs.map((d) => ({
          name: d.name,
          file: d.file,
          inWorkspace: d.inWorkspace,
          modifiedAt: d.modifiedAt,
          sizeBytes: d.sizeBytes,
        })),
        message: `${designs.length} design(s) in workspace, newest first.`,
      });
    },
  },

  {
    name: "pencil_get_active",
    description:
      'Return the .pen file currently displayed in the user\'s Pencil panel (if any). Use this when the user says "this design" / "the open one" to know which file to operate on. Filesystem-only — the binary\'s get_editor_state also includes this in `documentURI` if you need full editor state.',
    inputSchema: { type: "object", properties: {} },
    async run(_args, ctx: Context): Promise<ToolResult> {
      const active = getActivePen(ctx.storage);
      if (!active) {
        return okResult({
          file: null,
          message:
            "No design is open. Use pencil_list_designs to see what's available, pencil_open to switch to one, or pencil_new to start a blank canvas.",
        });
      }
      return okResult({
        file: active,
        message: `Currently open: ${active}.`,
      });
    },
  },

  {
    name: "pencil_open",
    description:
      "Switch the editor panel to a different .pen design. Wraps the binary's open_document with workspace-aware path resolution (accepts bare names, relative paths, or absolute paths) and updates the panel's switcher state.",
    inputSchema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: 'Workspace-relative or absolute .pen path (e.g. "src/screens/login.pen").',
        },
        name: {
          type: "string",
          description: "Storage-scope design name (kebab-case, no extension).",
        },
      },
      required: [],
    },
    async run(args, ctx: Context): Promise<ToolResult> {
      const a = args as unknown as OpenArgs;
      let file: string;
      try {
        file = a.file
          ? resolvePenPath(a.file, ctx)
          : penPathFor(safePenName(a.name ?? ""), ctx.storage, ctx.workspace);
      } catch (err) {
        return errResult((err as Error).message);
      }
      if (!fs.existsSync(file)) {
        return errResult(`No design at ${file}.`);
      }
      setActivePen(ctx.storage, file);
      pushFileUpdate(file, { zoomToFit: true });
      return okResult({
        file,
        message: `Switched the editor to ${file}.`,
      });
    },
  },

  {
    name: "pencil_new",
    description:
      "Create a brand-new blank canvas. Sets the active .pen path to <workspace>/.pencil/designs/<name>.pen and tells the editor to open a fresh empty document. The file is materialized on disk on the first edit/save. After this, drive the design with batch_design ops — every op renders live so the user watches it build.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: 'Kebab-case identifier (e.g. "agent-layout"). Used as the filename.',
        },
      },
      required: ["name"],
    },
    async run(args, ctx: Context): Promise<ToolResult> {
      const a = args as unknown as NewArgs;
      const name = safePenName(a.name);
      const file = penPathFor(name, ctx.storage, ctx.workspace);
      setActivePen(ctx.storage, file);
      // Fire-and-forget: tell the editor to switch to a blank doc. We do NOT
      // wait for a reply — the editor's `open-document` handler is sync and
      // doesn't always send a response, so awaiting would hang for 60s.
      notifyEditor("open-document", { filePath: "new" });
      // Side-channel SSE event so the panel's switcher updates immediately,
      // even though the .pen file won't exist on disk until the editor
      // (or agent via batch_design) triggers the first save.
      broadcastEvent("active-file", { path: file, name, pending: true });
      return okResult({
        file,
        message:
          `Blank canvas opened (will save to ${file} on first edit). ` +
          "Now use batch_design to build the design — each op renders live on the canvas.",
      });
    },
  },
];

// ---- Stateless Streamable HTTP MCP server --------------------------------

export const SESSION_ID = `pencil-aap-${Math.random().toString(36).slice(2, 12)}`;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: { name?: string; arguments?: Record<string, unknown>; protocolVersion?: string };
}
type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: string | number | null; result: unknown }
  | { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string } };

export async function handleMcpRequest(
  body: string,
  ctx: Context
): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  let req: JsonRpcRequest | JsonRpcRequest[];
  try {
    req = JSON.parse(body);
  } catch {
    return error(null, -32700, "parse error");
  }
  if (Array.isArray(req)) {
    const results = await Promise.all(req.map((r) => handleSingle(r, ctx)));
    return results.filter((r): r is JsonRpcResponse => r !== null);
  }
  return handleSingle(req, ctx);
}

async function handleSingle(req: JsonRpcRequest, ctx: Context): Promise<JsonRpcResponse | null> {
  const { id, method, params } = req || {};
  const isNotification = id === undefined || id === null;
  const safeId = id ?? null;

  try {
    switch (method) {
      case "initialize":
        return ok(safeId, {
          protocolVersion: params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: APP_NAME, version: APP_VERSION },
        });

      case "notifications/initialized":
        return null;

      case "tools/list": {
        // Merge our 4 workspace tools with the bundled MCP binary's full
        // editor surface (batch_design, get_editor_state, get_screenshot,
        // snapshot_layout, …). All tools that touch the canvas come from
        // the binary; ours are pure filesystem/state helpers.
        const binaryTools = await listBinaryTools().catch(() => []);
        const ourSet = new Set(TOOLS.map((t) => t.name));
        const merged = [
          ...TOOLS.map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          })),
          ...binaryTools
            .filter((t) => !ourSet.has(t.name))
            .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        ];
        return ok(safeId, { tools: merged });
      }

      case "tools/call": {
        const name = params?.name;
        if (typeof name !== "string") return error(safeId, -32602, "missing tool name");

        const tool = TOOLS.find((t) => t.name === name);
        if (tool) {
          const result = await tool.run(params?.arguments ?? {}, ctx);
          return ok(safeId, result);
        }

        // Forward to the binary — its result format (with content[]) is
        // already MCP-compliant; just return it as our `result`.
        const binaryResp = await callBinaryTool(name, params?.arguments);
        if (binaryResp.error) {
          return error(safeId, binaryResp.error.code ?? -32603, binaryResp.error.message);
        }
        return ok(safeId, binaryResp.result);
      }

      default:
        if (isNotification) return null;
        return error(safeId, -32601, `method not found: ${method}`);
    }
  } catch (err) {
    return error(safeId, -32603, err instanceof Error ? err.message : "internal error");
  }
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}
function error(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
