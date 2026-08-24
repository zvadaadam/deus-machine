import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createRouter } from "../src/lib/router.ts";

const PANEL_TOKEN = "test-panel-token";

interface TestApp {
  baseUrl: string;
  root: string;
  server: Server;
}

let apps: TestApp[] = [];

async function startApp(): Promise<TestApp> {
  const root = mkdtempSync(join(tmpdir(), "pencil-router-"));
  const workspace = join(root, "workspace");
  const storage = join(root, "storage");
  const editorBundleDir = join(root, "editor");
  const uiDir = join(root, "ui");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(storage, { recursive: true });
  mkdirSync(editorBundleDir, { recursive: true });
  mkdirSync(uiDir, { recursive: true });
  writeFileSync(join(uiDir, "parent.html"), "__PENCIL_PANEL_TOKEN__");
  writeFileSync(join(uiDir, "styles.css"), "");
  writeFileSync(join(uiDir, "app.js"), "");
  writeFileSync(join(editorBundleDir, "index.html"), "<!doctype html><html></html>");

  const handler = createRouter({ workspace, storage, editorBundleDir, panelToken: PANEL_TOKEN, uiDir });
  const server = createServer((req, res) => {
    handler(req, res).catch((err: unknown) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(err instanceof Error ? err.message : String(err));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("test server did not bind to a TCP port");
  }
  const app = { baseUrl: `http://127.0.0.1:${address.port}`, root, server };
  apps.push(app);
  return app;
}

afterEach(async () => {
  const toClose = apps;
  apps = [];
  await Promise.all(
    toClose.map(
      (app) =>
        new Promise<void>((resolve, reject) => {
          app.server.close((err) => {
            rmSync(app.root, { recursive: true, force: true });
            if (err) reject(err);
            else resolve();
          });
        })
    )
  );
});

describe("router security", () => {
  it("requires the panel token before dispatching editor filesystem IPC", async () => {
    const app = await startApp();
    const secretPath = join(app.root, "secret.txt");
    writeFileSync(secretPath, "top-secret");
    const body = JSON.stringify({
      id: "read-secret",
      type: "request",
      method: "read-file",
      payload: { path: secretPath },
    });

    const blocked = await fetch(`${app.baseUrl}/ipc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(blocked.status).toBe(403);

    const allowed = await fetch(`${app.baseUrl}/ipc`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Pencil-Panel-Token": PANEL_TOKEN,
      },
      body,
    });
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toMatchObject({
      id: "read-secret",
      type: "response",
      method: "read-file",
      payload: Array.from(Buffer.from("top-secret")),
    });
  });

  it("rejects browser-simple MCP posts that bypass CORS preflight", async () => {
    const app = await startApp();
    const response = await fetch(`${app.baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(response.status).toBe(415);
  });
});
