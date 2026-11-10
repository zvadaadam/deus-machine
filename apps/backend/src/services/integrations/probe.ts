// backend/src/services/integrations/probe.ts
// Checks an app the way a turn will use it: connect to its MCP server with
// the connection's credentials, list its tools, disconnect. A 401 means the
// account must sign in again; anything else is recorded as the last error.
// This is the "Ready · 24 tools" the Apps view shows.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig } from "@zvada/agent-server/protocol";
import { getErrorMessage } from "@shared/lib/errors";
import { extendCliPath } from "@shared/lib/cli-path";
import { createBackendChildEnv } from "../../runtime/child-env";
import type { AppTool } from "@shared/integrations/types";

const REMOTE_TIMEOUT_MS = 20_000;
/** A local server may download its package on first start (npx/uvx). */
const LOCAL_TIMEOUT_MS = 90_000;

export interface ProbeResult {
  ok: boolean;
  tools: AppTool[];
  unauthorized: boolean;
  error: string | null;
}

function transportFor(server: McpServerConfig): Transport {
  if (server.type === "stdio") {
    return new StdioClientTransport({
      command: server.command,
      args: server.args ?? [],
      // The user's environment without the backend's own (its auth token, its paths).
      env: Object.fromEntries(
        Object.entries(
          createBackendChildEnv({ PATH: extendCliPath(process.env.PATH), ...(server.env ?? {}) })
        ).filter((entry): entry is [string, string] => typeof entry[1] === "string")
      ),
      stderr: "ignore",
    });
  }
  // Streamable HTTP only: it is the one remote transport a turn uses, so a
  // server that speaks nothing else must not read as ready.
  return new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: server.headers ? { headers: server.headers } : undefined,
  });
}

function isUnauthorized(error: unknown): boolean {
  const message = getErrorMessage(error);
  return /\b401\b|unauthori[sz]ed|invalid[_ ]token/i.test(message);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A tool's first sentence or line: enough to say what it does on a row. */
function summary(description: string | undefined): string | undefined {
  const text = description?.trim();
  if (!text) return undefined;
  const first = text.split(/\n\s*\n|\n|(?<=\.)\s/)[0] ?? text;
  return first.length > 160 ? `${first.slice(0, 157)}…` : first;
}

async function listToolsWith(transport: Transport, timeoutMs: number): Promise<AppTool[]> {
  const client = new Client({ name: "deus", version: "1.0.0" }, { capabilities: {} });
  try {
    await withTimeout(client.connect(transport), timeoutMs, "Connecting");
    const tools: AppTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await withTimeout(
        client.listTools(cursor ? { cursor } : undefined),
        timeoutMs,
        "Listing tools"
      );
      for (const tool of page.tools) {
        tools.push({
          name: tool.name,
          ...(summary(tool.description) ? { description: summary(tool.description) } : {}),
          ...(tool.annotations?.readOnlyHint === true ? { readOnly: true } : {}),
        });
      }
      cursor = page.nextCursor;
    } while (cursor && tools.length < 2_000);
    return tools;
  } finally {
    await client.close().catch(() => {});
  }
}

export async function probeServer(server: McpServerConfig): Promise<ProbeResult> {
  const timeoutMs = server.type === "stdio" ? LOCAL_TIMEOUT_MS : REMOTE_TIMEOUT_MS;
  try {
    const tools = await listToolsWith(transportFor(server), timeoutMs);
    return { ok: true, tools, unauthorized: false, error: null };
  } catch (error) {
    return {
      ok: false,
      tools: [],
      unauthorized: isUnauthorized(error),
      error: getErrorMessage(error),
    };
  }
}
