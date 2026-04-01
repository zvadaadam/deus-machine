/**
 * Headless serve mode — starts agent-server, backend, and serves the web UI.
 *
 * Process orchestration mirrors scripts/dev.sh but in production mode:
 * 1. Start agent-server → capture LISTEN_URL from stdout
 * 2. Start backend with AGENT_SERVER_URL → capture [BACKEND_PORT] from stdout
 * 3. Serve static frontend files, proxying /api and /ws to backend
 */

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { platform, homedir, networkInterfaces } from "node:os";
import { mkdirSync } from "node:fs";
import {
  spinner as createSpinner,
  statusLine,
  c,
  sym,
  box,
  divider,
  kv,
  blank,
  sleep,
  success,
  error,
  warn,
  hint,
  gradientText,
} from "./ui.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

export interface ServeOptions {
  port: number;
  host: string;
  open: boolean;
  dataDir?: string;
}

interface ProcessInfo {
  process: ChildProcess;
  name: string;
}

export async function serve(options: ServeOptions): Promise<void> {
  const { port, host, open, dataDir } = options;

  // Resolve paths to bundles
  const paths = resolveBundlePaths();
  if (!paths) {
    error("Could not find Deus bundles.");
    blank();
    hint(`Run ${c.cyan("bun run build:cli")} from the monorepo root first.`);
    blank();
    process.exit(1);
  }

  // Resolve Node binary (handles Electron ABI mismatch in dev)
  const nodeCmd = resolveNodeBinary();

  // Resolve database
  const dbPath = resolveDataDir(dataDir);
  kv("Database", c.dim(dbPath));
  blank();

  // Track child processes for cleanup
  const children: ProcessInfo[] = [];
  let status: ReturnType<typeof statusLine> | null = null;

  function shutdown() {
    if (status) status.stop();
    blank();

    const msg = gradientText("Thanks for using Deus!", [167, 139, 250], [34, 211, 238]);
    console.log(`  ${msg}`);
    blank();

    for (const child of children) {
      if (!child.process.killed) child.process.kill("SIGTERM");
    }
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // ── Step 1: Agent server ─────────────────────────────────────────
  const s1 = createSpinner("Starting agent server...");
  const agentServerUrl = await startProcess({
    name: "agent-server",
    command: nodeCmd,
    args: [paths.agentServer],
    env: { DATABASE_PATH: dbPath },
    waitFor: /LISTEN_URL=(.+)/,
    children,
  });

  if (!agentServerUrl) {
    s1.fail("Agent server failed to start");
    blank();
    process.exit(1);
  }
  s1.succeed(`Agent server ${c.dim("ready")}`);

  // ── Step 2: Backend ──────────────────────────────────────────────
  const s2 = createSpinner("Starting backend...");
  const backendPort = await startProcess({
    name: "backend",
    command: nodeCmd,
    args: [paths.backend],
    env: {
      AGENT_SERVER_URL: agentServerUrl,
      DATABASE_PATH: dbPath,
      PORT: "0",
    },
    waitFor: /\[BACKEND_PORT\](\d+)/,
    children,
  });

  if (!backendPort) {
    s2.fail("Backend failed to start");
    blank();
    process.exit(1);
  }
  s2.succeed(`Backend ${c.dim("ready")}`);

  // ── Step 3: Web server ───────────────────────────────────────────
  const hasFrontend = existsSync(paths.frontend) && existsSync(join(paths.frontend, "index.html"));

  const s3 = createSpinner("Starting web server...");
  const webServer = createWebServer(parseInt(backendPort, 10), paths.frontend);

  await new Promise<void>((resolve) => {
    webServer.listen(port, host, () => resolve());
  });

  if (hasFrontend) {
    s3.succeed(`Web UI ${c.dim("ready")}`);
  } else {
    s3.warn(`Web UI ${c.dim("— frontend not built, API-only mode")}`);
  }

  // ── Ready! ───────────────────────────────────────────────────────
  blank();

  const url = `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`;
  box(
    [
      gradientText("Deus is running", [167, 139, 250], [34, 211, 238]),
      "",
      c.bold(c.brightWhite(url)),
    ],
    { borderColor: c.cyan, width: 38 }
  );

  blank();
  kv("Local", c.cyan(url), 10);

  // Show network URL if binding to all interfaces or a specific host
  const lanIp = getLanIp();
  if (lanIp && (host === "0.0.0.0" || host === "localhost")) {
    kv("Network", c.dim(`http://${lanIp}:${port}`), 10);
  }

  // ── Remote Access ────────────────────────────────────────────────
  blank();
  divider("Remote Access");
  blank();
  hint("To access from your phone or another computer:");
  blank();
  console.log(`    1. Open  ${c.cyan(c.underline("app.rundeus.com"))}`);
  console.log(`    2. Pair your device with this server`);
  blank();
  hint(`Or enable remote access in Settings ${sym.arrow} Remote Access`);
  blank();
  divider();

  // ── API Key Check ────────────────────────────────────────────────
  const hasApiKey = !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);
  if (!hasApiKey) {
    blank();
    warn("No API key detected in environment");
    blank();
    hint("AI agents need an API key to work. Set one of:");
    blank();
    console.log(`    ${c.cyan("export ANTHROPIC_API_KEY")}=${c.dim('"sk-ant-..."')}`);
    console.log(`    ${c.cyan("export OPENAI_API_KEY")}=${c.dim('"sk-..."')}`);
    blank();
    hint(`Or configure it in the app: Settings ${sym.arrow} API Keys`);
    blank();
    divider();
  }

  // ── Status line ──────────────────────────────────────────────────
  blank();
  const startedAt = new Date();
  status = statusLine(() => {
    const elapsed = formatUptime(Date.now() - startedAt.getTime());
    return `${c.dim(`Running for ${elapsed}`)}  ${c.dim(`${sym.bullet} Ctrl+C to stop`)}`;
  }, 2000);

  if (open) {
    openBrowser(url);
  }

  // Keep the process alive
  await new Promise(() => {});
}

// ── Bundle resolution ────────────────────────────────────────────────

function resolveBundlePaths(): {
  agentServer: string;
  backend: string;
  frontend: string;
} | null {
  const cliRoot = resolve(__dirname, "..");

  // Bundled mode (npm package)
  const bundledDir = join(cliRoot, "bundles");
  if (existsSync(join(bundledDir, "agent-server.bundled.cjs"))) {
    return {
      agentServer: join(bundledDir, "agent-server.bundled.cjs"),
      backend: join(bundledDir, "server.bundled.cjs"),
      frontend: join(bundledDir, "web"),
    };
  }

  // Dev mode (monorepo)
  const monorepoRoot = resolve(cliRoot, "../..");
  const agentServer = join(monorepoRoot, "apps/agent-server/dist/index.bundled.cjs");
  const backend = join(monorepoRoot, "apps/backend/dist/server.bundled.cjs");
  const frontend = join(monorepoRoot, "apps/web/dist/web");

  if (existsSync(agentServer) && existsSync(backend)) {
    return { agentServer, backend, frontend };
  }

  return null;
}

// ── Data directory ───────────────────────────────────────────────────

function resolveDataDir(customDir?: string): string {
  if (customDir) {
    mkdirSync(customDir, { recursive: true });
    return join(customDir, "deus.db");
  }

  const os = platform();
  let dir: string;

  if (os === "darwin") {
    dir = join(homedir(), "Library/Application Support/com.deus.app");
  } else if (os === "win32") {
    dir = join(process.env.APPDATA || join(homedir(), "AppData/Roaming"), "com.deus.app");
  } else {
    dir = join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "deus");
  }

  mkdirSync(dir, { recursive: true });
  return join(dir, "deus.db");
}

// ── Node binary resolution ───────────────────────────────────────────

function resolveNodeBinary(): string {
  if (process.env.ELECTRON_RUN_AS_NODE === "1") return process.execPath;

  try {
    const electronPath = execSync(
      'node -e "try { console.log(require(\'electron\')) } catch { process.exit(1) }"',
      { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }
    ).trim();

    if (electronPath && existsSync(electronPath)) {
      try {
        execSync(
          "node -e \"const D = require('better-sqlite3'); const d = new D(':memory:'); d.close()\"",
          { timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }
        );
        return process.execPath;
      } catch {
        return electronPath;
      }
    }
  } catch {}

  return process.execPath;
}

// ── Process spawner ──────────────────────────────────────────────────

async function startProcess(opts: {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  waitFor: RegExp;
  children: ProcessInfo[];
  timeoutMs?: number;
}): Promise<string | null> {
  const { name, command, args, env, waitFor, children, timeoutMs = 15_000 } = opts;

  return new Promise((resolve) => {
    const extraEnv: Record<string, string> = {};
    if (command !== process.execPath && command.includes("Electron")) {
      extraEnv.ELECTRON_RUN_AS_NODE = "1";
    }

    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...extraEnv, ...env },
    });

    children.push({ process: child, name });

    let buffer = "";
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    }, timeoutMs);

    child.stdout?.on("data", (data: Buffer) => {
      buffer += data.toString();
      const match = buffer.match(waitFor);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });

    child.stderr?.on("data", () => {
      // Suppress stderr in normal mode
    });

    child.on("exit", (code, signal) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve(null);
      }
    });
  });
}

// ── Web server (static + proxy) ──────────────────────────────────────

function createWebServer(backendPort: number, frontendDir: string) {
  const hasFrontend = existsSync(frontendDir) && existsSync(join(frontendDir, "index.html"));

  const server = createServer(async (req, res) => {
    const url = req.url || "/";

    if (url.startsWith("/api/") || url.startsWith("/api")) {
      return proxyRequest(req, res, backendPort);
    }

    if (url === "/__backend_port") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify({ port: backendPort }));
      return;
    }

    if (hasFrontend) {
      serveStaticFile(req, res, frontendDir);
    } else {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html><html><head><title>Deus IDE</title>
<style>body{font-family:system-ui;padding:3rem;background:#0a0a0a;color:#e5e5e5}
code{background:#1a1a1a;padding:2px 6px;border-radius:4px;font-size:14px}
a{color:#22d3ee}</style></head><body>
<h1>Deus IDE Server</h1>
<p>Backend API: <code>http://localhost:${backendPort}/api</code></p>
<p>WebSocket: <code>ws://localhost:${backendPort}/ws</code></p>
<p style="color:#a3a3a3">Frontend not built. Run <code>bun run build:web</code> to enable the UI.</p>
</body></html>`);
    }
  });

  server.on("upgrade", (req, socket, head) => {
    const proxyReq = httpRequest({
      hostname: "localhost",
      port: backendPort,
      path: req.url,
      method: req.method,
      headers: req.headers,
    });

    proxyReq.on("upgrade", (_proxyRes: any, proxySocket: any, proxyHead: any) => {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          Object.entries(_proxyRes.headers)
            .map(([k, v]: [string, any]) => `${k}: ${v}`)
            .join("\r\n") +
          "\r\n\r\n"
      );
      if (proxyHead.length > 0) socket.write(proxyHead);
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
    });

    proxyReq.on("error", () => socket.end());
    proxyReq.end();
  });

  return server;
}

function proxyRequest(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  backendPort: number
) {
  const proxyReq = httpRequest(
    {
      hostname: "localhost",
      port: backendPort,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `localhost:${backendPort}` },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on("error", () => {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Backend unavailable" }));
  });

  req.pipe(proxyReq);
}

function serveStaticFile(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  frontendDir: string
) {
  let pathname = (req.url || "/").split("?")[0];
  if (pathname === "/") pathname = "/index.html";

  let filePath = join(frontendDir, pathname);

  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(frontendDir, "index.html");
  }

  if (!existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const ext = extname(filePath);
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  try {
    const content = readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
    });
    res.end(content);
  } catch {
    res.writeHead(500);
    res.end("Internal server error");
  }
}

// ── Utilities ────────────────────────────────────────────────────────

function getLanIp(): string | null {
  const nets = networkInterfaces();
  for (const ifaces of Object.values(nets)) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

function openBrowser(url: string) {
  const os = platform();
  const cmd = os === "darwin" ? "open" : os === "win32" ? "start" : "xdg-open";
  spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
