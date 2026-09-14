/* global document */
// A control edit must not give its consumers a new, disconnected transport.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";
import { WebSocketServer } from "ws";

const root = path.resolve(import.meta.dirname, "../..");
const fixture = path.join(root, ".context/query-protocol-hmr");
const buttonPath = path.join(root, "apps/web/src/components/ui/button.tsx");
await mkdir(fixture, { recursive: true });
await writeFile(
  path.join(fixture, "index.html"),
  '<!doctype html><html><body><p id="connection">Connecting</p><div id="root"></div><script type="module" src="/entry.tsx"></script></body></html>'
);
await writeFile(
  path.join(fixture, "entry.tsx"),
  `import React from "react";
import { createRoot } from "react-dom/client";
import { connect, onConnectionChange } from "@/platform/ws";
import { ChatAction } from "./ChatAction";
onConnectionChange(connected => document.getElementById("connection").textContent = connected ? "Connected" : "Disconnected");
await connect();
createRoot(document.getElementById("root")).render(<ChatAction />);
`
);
await writeFile(
  path.join(fixture, "ChatAction.tsx"),
  `import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { sendMutate } from "@/platform/ws";
export function ChatAction() {
  const [result, setResult] = useState("");
  return <><Button onClick={async () => {
    try {
      const response = await sendMutate("createSession", { workspaceId: "fixture-workspace" });
      setResult(response.data.id);
    } catch (error) { setResult(error.message); }
  }}>New chat</Button><output>{result}</output></>;
}
`
);

const backend = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await once(backend, "listening");
let connections = 0;
let mutations = 0;
backend.on("connection", (socket) => {
  connections++;
  socket.send(JSON.stringify({ type: "connected", connectionId: "fixture-connection" }));
  socket.on("message", (data) => {
    const frame = JSON.parse(data.toString());
    assert.equal(frame.type, "q:mutate");
    assert.equal(frame.action, "createSession");
    assert.deepEqual(frame.params, { workspaceId: "fixture-workspace" });
    socket.send(
      JSON.stringify({
        type: "q:mutate_result",
        id: frame.id,
        success: true,
        data: { id: `session-${++mutations}` },
      })
    );
  });
});

let revision = 1;
const server = await createServer({
  configFile: false,
  root: fixture,
  logLevel: "error",
  cacheDir: path.join(fixture, "vite-cache"),
  define: { "import.meta.env.VITE_BACKEND_PORT": JSON.stringify(String(backend.address().port)) },
  resolve: {
    alias: { "@": path.join(root, "apps/web/src"), "@shared": path.join(root, "shared") },
  },
  plugins: [
    {
      name: "edit-control-in-memory",
      enforce: "pre",
      transform(code, id) {
        if (id === buttonPath) {
          return code.replace(
            'data-slot="button"',
            `data-slot="button" data-revision="${revision}"`
          );
        }
      },
    },
    react(),
  ],
  server: { host: "127.0.0.1", port: 0, fs: { allow: [root] } },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  const action = page.getByRole("button", { name: "New chat", exact: true });
  await action.click();
  await page.locator("output").filter({ hasText: "session-1" }).waitFor();

  for (revision = 2; revision <= 3; revision++) {
    // Exercise Vite's actual invalidation and React Refresh without editing source files.
    server.watcher.emit("change", buttonPath);
    await page.locator(`button[data-revision="${revision}"]`).waitFor();
    assert.equal(await page.locator("#connection").textContent(), "Connected");
    await action.click();
    await page.waitForFunction(
      (previous) => document.querySelector("output").textContent !== previous,
      `session-${revision - 1}`
    );
    assert.equal(await page.locator("output").textContent(), `session-${revision}`);
  }
  assert.equal(connections, 1, "Control edits preserve the connected socket without reloading");
  assert.equal(mutations, 3, "Every click reaches the backend exactly once");
  assert.deepEqual(errors, []);
  console.log("PASS: new chats reach the same connection before and after repeated hot reloads.");
} finally {
  await browser?.close();
  await server.close();
  for (const socket of backend.clients) socket.terminate();
  await new Promise((resolve) => backend.close(resolve));
}
