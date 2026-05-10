// packages/pencil/src/lib/mcp-binary.ts
//
// Manages the bundled Pencil MCP binary as a long-lived child of the AAP.
// The binary connects to our TransportServer (lib/transport-server.ts) and
// exposes the *full* Pencil tool surface (batch_design, get_editor_state,
// get_screenshot, batch_get, …) over its own HTTP MCP at a private port.
//
// We then proxy that HTTP MCP into our /mcp endpoint:
//   - tools/list returns the merged set of (our 7 custom tools + binary's ~14)
//   - tools/call routes to whichever owner has the named tool
//
// The agent ends up with one MCP URL (what the AAP manifest declares) but
// gets the full toolset.

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

interface BinaryProc {
  child: ChildProcess;
  httpPort: number;
  /** MCP session id we negotiated for ourselves so we can drive the binary. */
  sessionId: string | null;
  /** Tool list the binary advertises, cached after a single tools/list call. */
  cachedTools: ToolDescriptor[] | null;
}

interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: unknown;
}

let proc: BinaryProc | null = null;

/** Find the bundled Pencil MCP binary. Same lookup as cli.ts but specific
 *  to the OS-suffixed binary; we walk every candidate dir for an exact match. */
function findBundledMcpBinary(): string | null {
  const platform =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "linux"
        ? "linux"
        : process.platform === "win32"
          ? "windows"
          : null;
  if (!platform) return null;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  if (!arch) return null;
  const ext = platform === "windows" ? ".exe" : "";
  const name = `mcp-server-${platform}-${arch}${ext}`;

  const candidates: string[] = [];
  // The CLI we depend on bundles the binary in dist/out/.
  try {
    const cliPkg = require.resolve("@pencil.dev/cli/package.json");
    candidates.push(join(dirname(cliPkg), "dist", "out", name));
  } catch {
    /* fall through to other locations */
  }
  // Cursor / VS Code extension's copy.
  const HOME = homedir();
  for (const editor of [".cursor", ".vscode"]) {
    const root = join(HOME, editor, "extensions");
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const dir of entries
      .filter((d) => d.startsWith("highagency.pencildev-"))
      .sort()
      .reverse()) {
      candidates.push(join(root, dir, "out", name));
    }
  }
  // Pencil Desktop's bundle (unpacked binary).
  candidates.push(`/Applications/Pencil.app/Contents/Resources/app.asar.unpacked/out/${name}`);
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/** Pick a free localhost port. */
function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error("could not allocate port"));
      }
    });
  });
}

/** Start the binary in HTTP mode pointed at our `-app deus` socket. */
export async function startMcpBinary(): Promise<{ httpPort: number } | null> {
  if (proc) return { httpPort: proc.httpPort };
  const binary = findBundledMcpBinary();
  if (!binary) {
    console.warn("[pencil-binary] bundled MCP binary not found — full tool surface disabled");
    return null;
  }
  const httpPort = await pickFreePort();
  console.log(`[pencil-binary] launching ${binary} -app deus -http -http-port ${httpPort}`);
  const child = spawn(binary, ["-app", "deus", "-http", "-http-port", String(httpPort)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (c) => process.stdout.write(`[mcp-bin] ${c}`));
  child.stderr.on("data", (c) => process.stderr.write(`[mcp-bin] ${c}`));
  child.on("error", (err) => console.error(`[pencil-binary] spawn err: ${err.message}`));
  child.on("exit", (code, signal) => {
    console.warn(`[pencil-binary] exited code=${code} signal=${signal}`);
    proc = null;
  });
  proc = { child, httpPort, sessionId: null, cachedTools: null };

  // Wait for the binary's HTTP server to come up.
  for (let i = 0; i < 30; i++) {
    if (await isPortOpen(httpPort)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return { httpPort };
}

export async function stopMcpBinary(): Promise<void> {
  if (!proc) return;
  try {
    proc.child.kill("SIGTERM");
  } catch {
    /* gone */
  }
  proc = null;
}

function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => {
      sock.destroy();
      resolve(false);
    });
  });
}

// ---- Proxy helpers --------------------------------------------------------

async function ensureSessionId(): Promise<string | null> {
  if (!proc) return null;
  if (proc.sessionId) return proc.sessionId;
  const res = await fetch(`http://127.0.0.1:${proc.httpPort}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "deus-pencil-aap", version: "0.2.0" },
      },
    }),
  });
  if (!res.ok) return null;
  const sid = res.headers.get("mcp-session-id");
  if (!sid) return null;
  proc.sessionId = sid;
  // Send the required notifications/initialized.
  await fetch(`http://127.0.0.1:${proc.httpPort}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Mcp-Session-Id": sid },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  return sid;
}

/** Return the binary's tool list, cached after the first call. */
export async function listBinaryTools(): Promise<ToolDescriptor[]> {
  if (!proc) return [];
  if (proc.cachedTools) return proc.cachedTools;
  const sid = await ensureSessionId();
  if (!sid) return [];
  const res = await fetch(`http://127.0.0.1:${proc.httpPort}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Session-Id": sid,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { result?: { tools?: ToolDescriptor[] } };
  proc.cachedTools = data.result?.tools ?? [];
  return proc.cachedTools;
}

interface CallResultJson {
  result?: unknown;
  error?: { code: number; message: string };
}

/** Forward a tools/call to the binary. Returns the binary's `result` block
 *  unchanged so we can pass it straight through to the agent. */
export async function callBinaryTool(
  name: string,
  args: Record<string, unknown> | undefined
): Promise<CallResultJson> {
  if (!proc) return { error: { code: -32000, message: "binary not running" } };
  const sid = await ensureSessionId();
  if (!sid) return { error: { code: -32000, message: "binary handshake failed" } };
  const res = await fetch(`http://127.0.0.1:${proc.httpPort}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Session-Id": sid,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name, arguments: args ?? {} },
    }),
  });
  if (!res.ok) return { error: { code: -32000, message: `binary HTTP ${res.status}` } };
  const data = (await res.json()) as CallResultJson;
  return data;
}

export function getBinaryStatus(): {
  running: boolean;
  httpPort: number | null;
  hasSession: boolean;
  cachedToolCount: number;
} {
  return {
    running: !!proc,
    httpPort: proc?.httpPort ?? null,
    hasSession: !!proc?.sessionId,
    cachedToolCount: proc?.cachedTools?.length ?? 0,
  };
}
