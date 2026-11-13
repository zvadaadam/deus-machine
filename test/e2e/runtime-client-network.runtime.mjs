/* global window, document */
// Real app + real backend/SQLite, with transport faults at the browser boundary.
// Node 22, Bun dependencies and Playwright Chromium are required. No paid agent turn.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { createServer } from "vite";
import { chromium } from "playwright";
import { SCHEMA_SQL } from "../../shared/schema.ts";

const root = path.resolve(import.meta.dirname, "../..");
const evidence = path.join(root, ".context/runtime-network");
await mkdir(evidence, { recursive: true });
const directory = await mkdtemp(path.join(evidence, "run-"));
const repository = crypto.randomUUID(),
  workspace = crypto.randomUUID(),
  session = crypto.randomUUID();
const repo = path.join(directory, "repository");
await mkdir(repo);
execFileSync("git", ["init", "-b", "main", repo], { stdio: "pipe" });
const db = new Database(path.join(directory, "deus.db"));
db.exec(SCHEMA_SQL);
db.pragma("journal_mode = WAL");
db.prepare("INSERT INTO repositories (id, name, root_path) VALUES (?, 'Network test', ?)").run(
  repository,
  repo
);
db.prepare(
  "INSERT INTO workspaces (id, repository_id, slug, title, state, current_session_id, git_branch, git_target_branch) VALUES (?, ?, 'network', 'Network baseline', 'ready', ?, 'main', 'main')"
).run(workspace, repository, session);
db.prepare(
  "INSERT INTO sessions (id, workspace_id, agent_harness, status) VALUES (?, ?, 'claude-code', 'idle')"
).run(session, workspace);
await writeFile(
  path.join(directory, "preferences.json"),
  JSON.stringify({
    onboarding_completed: true,
    analytics_enabled: false,
    remote_access_enabled: false,
    theme: "dark",
  })
);
const backendLog = createWriteStream(path.join(directory, "backend.log"));
const child = spawn(process.execPath, ["--import", "tsx", "apps/backend/src/server.ts"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    PORT: "0",
    DATABASE_PATH: path.join(directory, "deus.db"),
    TSX_TSCONFIG_PATH: path.join(root, "apps/backend/tsconfig.json"),
    AGNT_API_KEY: "",
    DEUS_CLOUD_AGNT_API_KEY: "",
  },
});
child.stdout.pipe(backendLog);
child.stderr.pipe(backendLog);
let vite, browser;
const errors = [],
  report = { checks: [], directory };
const check = (name, details = {}) => {
  report.checks.push({ name, ...details });
  console.log(`PASS: ${name}`);
};

// Delay both directions in FIFO order. A WebSocket runs over TCP: throttling
// must not invent out-of-order messages. Every close cancels that socket's queue.
async function faultNetwork(page) {
  const control = {
    latency: 0,
    bytesPerSecond: Infinity,
    blackhole: false,
    dropAck: false,
    delayWriteResult: 0,
    connections: [],
    sent: [],
    received: [],
    current: undefined,
  };
  await page.routeWebSocket(
    (url) => url.pathname === "/ws",
    (route) => {
      const server = route.connectToServer();
      const link = {
        route,
        server,
        closed: false,
        timers: new Set(),
        due: { up: 0, down: 0 },
        subscriptions: new Map(),
      };
      control.connections.push(link);
      control.current = link;
      const close = (code = 1011, reason = "Injected outage") => {
        if (link.closed) return;
        link.closed = true;
        link.timers.forEach(clearTimeout);
        link.timers.clear();
        void route.close({ code, reason });
        void server.close({ code, reason });
      };
      link.close = close;
      route.onClose(() => close(1000, "Client closed"));
      server.onClose(() => close(1000, "Server closed"));
      const queue = (direction, raw, extraDelay = 0) => {
        const bytes = Buffer.byteLength(String(raw));
        const now = Date.now();
        link.due[direction] =
          Math.max(now + control.latency + extraDelay, link.due[direction]) +
          (bytes / control.bytesPerSecond) * 1000;
        const timer = setTimeout(
          () => {
            link.timers.delete(timer);
            if (!link.closed) (direction === "up" ? server : route).send(raw);
          },
          Math.max(0, link.due[direction] - now)
        );
        link.timers.add(timer);
      };
      route.onMessage((raw) => {
        const frame = JSON.parse(String(raw));
        control.sent.push(frame);
        if (frame.type === "q:subscribe") link.subscriptions.set(frame.id, frame.resource);
        if (frame.type === "q:unsubscribe") link.subscriptions.delete(frame.id);
        if (!control.blackhole) queue("up", raw);
      });
      server.onMessage((raw) => {
        const frame = JSON.parse(String(raw));
        control.received.push(frame);
        if (control.blackhole) {
          // Keep the server leg alive so recovery must come from the CLIENT'S
          // watchdog, rather than a normal server close notification.
          if (frame.type === "ping") server.send(JSON.stringify({ type: "pong" }));
          return;
        }
        if (control.dropAck && frame.type === "q:mutate_result") {
          control.dropAck = false;
          close();
          return;
        }
        queue("down", raw, frame.type === "q:mutate_result" ? control.delayWriteResult : 0);
      });
    }
  );
  return control;
}

try {
  const port = await new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(
      () => reject(new Error("Backend startup timed out; see backend.log")),
      30000
    );
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Backend exited ${code}`));
    });
    child.stdout.on("data", (data) => {
      output += String(data);
      const match = output.match(/^\[BACKEND_PORT\](\d+)$/m);
      if (match) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    });
  });
  vite = await createServer({
    configFile: path.join(root, "apps/web/vite.config.ts"),
    cacheDir: path.join(directory, "vite-cache"),
    logLevel: "error",
    define: { "import.meta.env.VITE_BACKEND_PORT": JSON.stringify(String(port)) },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [root] } },
  });
  await vite.listen();
  const url = `${vite.resolvedUrls.local[0]}s/local/w/${workspace}`;
  browser = await chromium.launch({ headless: true });
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const a = await desktop.newPage(),
    b = await mobile.newPage();
  for (const page of [a, b]) {
    page.setDefaultTimeout(20000);
    page.on("pageerror", (error) => errors.push(error.message));
  }
  const netA = await faultNetwork(a),
    netB = await faultNetwork(b);
  netA.latency = 700;
  netA.bytesPerSecond = 24 * 1024;
  const module = "/src/platform/ws/query-protocol-client.ts";
  const attach = async (page) => {
    await page.evaluate(async (module) => {
      window.testClient = (await import(module)).getRuntimeClient();
      window.testStates = [];
      window.testClient.onStateChange((state) =>
        window.testStates.push({ state, time: Date.now() })
      );
    }, module);
    await page.waitForFunction(() => window.testClient.isConnected());
  };
  const visible = (page, title) => page.getByText(title, { exact: true }).first().waitFor();
  const rename = (page, title) =>
    page.evaluate(
      async ({ workspace, title }) => {
        try {
          return await window.testClient.sendMutate("updateWorkspaceTitle", {
            workspaceId: workspace,
            title,
          });
        } catch (error) {
          return { kind: error.kind };
        }
      },
      { workspace, title }
    );
  const cached = (page) =>
    page.evaluate(
      (workspace) =>
        window.testClient.queryClient
          .getQueriesData({ queryKey: ["workspaces", "by-repo"] })
          .flatMap(([, groups]) => groups ?? [])
          .flatMap((group) => group.workspaces)
          .find((row) => row.id === workspace)?.title,
      workspace
    );
  const diagnostics = (page) => page.evaluate(() => window.testClient.diagnostics());
  const settled = (page) =>
    page.waitForFunction(
      () => window.testClient.isConnected() && window.testClient.diagnostics().pending === 0
    );

  await Promise.all([a.goto(url), b.goto(url)]);
  await Promise.all([
    attach(a),
    attach(b),
    visible(a, "Network baseline"),
    visible(b, "Network baseline"),
  ]);
  const started = Date.now();
  assert.equal((await rename(a, "Slow network update")).success, true);
  await Promise.all([visible(a, "Slow network update"), visible(b, "Slow network update")]);
  assert(Date.now() - started >= 1300);
  check("Real app loads and writes with 700ms latency each way and 24 KiB/s bandwidth", {
    writeMs: Date.now() - started,
  });

  const burst = await a.evaluate(
    async (workspace) =>
      Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          window.testClient.sendMutate("updateWorkspaceTitle", {
            workspaceId: workspace,
            title: `Burst ${index}`,
          })
        )
      ),
    workspace
  );
  assert(burst.every((result) => result.success));
  await Promise.all([visible(a, "Burst 19"), visible(b, "Burst 19")]);
  assert.equal(
    netA.sent.filter(
      (frame) => frame.type === "q:mutate" && frame.params.title?.startsWith("Burst ")
    ).length,
    20
  );
  await settled(a);
  check("20 rapid writes preserve order, update both viewers and settle without duplicate sends");
  netA.latency = 0;
  netA.bytesPerSecond = Infinity;

  await mobile.setOffline(true);
  netB.current.close();
  await b.waitForFunction(() => !window.testClient.isConnected());
  assert.equal(await cached(b), "Burst 19");
  assert.equal((await rename(b, "Must not queue")).kind, "unavailable");
  assert.equal((await rename(a, "Changed during outage")).success, true);
  assert.equal(await cached(b), "Burst 19");
  await mobile.setOffline(false);
  await settled(b);
  await visible(b, "Changed during outage");
  // The write refused while offline was never put on the wire, then or after reconnecting.
  assert.equal(
    netB.sent.filter(
      (frame) => frame.type === "q:mutate" && frame.params?.title === "Must not queue"
    ).length,
    0
  );
  check(
    "Offline viewer retains cached data, rejects writes immediately and catches up automatically"
  );

  for (let cycle = 0; cycle < 5; cycle++) {
    const generation = (await diagnostics(a)).generation;
    netA.current.close();
    await a.waitForFunction(
      (old) => window.testClient.isConnected() && window.testClient.diagnostics().generation > old,
      generation
    );
    await settled(a);
  }
  assert.equal(netA.connections.filter((link) => !link.closed).length, 1);
  const baseline = (await diagnostics(a)).subscriptions;
  check("Five repeated disconnects leave one connection and restore the same subscriptions", {
    subscriptions: baseline,
  });

  const countSessions = () =>
    db.prepare("SELECT count(*) AS count FROM sessions WHERE workspace_id = ?").get(workspace)
      .count;
  const before = countSessions();
  netA.dropAck = true;
  await a.getByRole("button", { name: "New chat tab", exact: true }).click();
  await a.waitForFunction(() => !window.testClient.isConnected());
  await settled(a);
  assert.equal(countSessions(), before + 1);
  assert.equal(
    netA.sent.filter((frame) => frame.type === "q:mutate" && frame.action === "createSession")
      .length,
    1
  );
  check("Actual New chat click commits once when its ACK is lost; reconnect never resends it");

  netA.delayWriteResult = 500;
  const timedOut = await a.evaluate(async (session) => {
    try {
      return await window.testClient.sendMutate("stopSession", { sessionId: session }, 50);
    } catch (error) {
      return { kind: error.kind };
    }
  }, session);
  assert.equal(timedOut.kind, "unknown-outcome");
  assert.equal((await rename(a, "After late acknowledgment")).success, true);
  await visible(a, "After late acknowledgment");
  assert.equal((await diagnostics(a)).pending, 0);
  netA.delayWriteResult = 0;
  check("A delayed write result times out as uncertain and cannot complete a later request");

  // Exercise authoritative absence through the actual backend and app binding.
  await a.evaluate(() => {
    window.testClient.queryClient.setQueryData(["missing-session"], { id: "old" });
    window.stopMissing = window.testClient.retainQuery("session", { sessionId: "does-not-exist" }, [
      "missing-session",
    ]);
  });
  await a.waitForFunction(
    () => window.testClient.queryClient.getQueryData(["missing-session"]) === null
  );
  await a.evaluate(() => window.stopMissing());
  check("An authoritative missing-session snapshot removes stale cached data");

  await a.reload();
  await attach(a);
  await visible(a, "After late acknowledgment");
  await settled(a);
  check("Full page reload rehydrates persisted state");

  console.log("Testing silent connection failure with the production 30s + 10s watchdog...");
  const silentStarted = Date.now();
  await a.evaluate(() => {
    window.testStates = [];
  });
  netA.blackhole = true;
  await a.waitForFunction(
    () => window.testStates.some((entry) => entry.state === "offline"),
    null,
    { timeout: 45000 }
  );
  const detectedMs = Date.now() - silentStarted;
  assert.equal(await cached(a), "After late acknowledgment");
  netA.blackhole = false;
  await settled(a);
  assert.equal((await rename(a, "Recovered from silent failure")).success, true);
  await Promise.all([
    visible(a, "Recovered from silent failure"),
    visible(b, "Recovered from silent failure"),
  ]);
  check("Silent traffic loss is detected without a close event and recovers cached state", {
    detectedMs,
  });

  await Promise.all([settled(a), settled(b)]);
  assert.equal(netA.connections.filter((link) => !link.closed).length, 1);
  assert.equal((await diagnostics(a)).subscriptions, baseline);
  assert.equal(
    await b.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true
  );
  assert.deepEqual(errors, []);
  report.desktop = await diagnostics(a);
  report.mobile = await diagnostics(b);
  report.errors = errors;
  await a.screenshot({ path: path.join(evidence, "desktop.png") });
  await b.screenshot({ path: path.join(evidence, "mobile.png") });
  check("No leaked subscriptions, pending operations, duplicate sockets or browser errors remain");
  await writeFile(path.join(evidence, "browser-results.json"), JSON.stringify(report, null, 2));
} catch (error) {
  report.error = error.stack;
  report.errors = errors;
  await writeFile(path.join(evidence, "browser-results.json"), JSON.stringify(report, null, 2));
  for (const [index, context] of (browser?.contexts() ?? []).entries()) {
    for (const page of context.pages())
      await page.screenshot({ path: path.join(evidence, `failure-${index}.png`) }).catch(() => {});
  }
  throw error;
} finally {
  await browser?.close();
  await vite?.close();
  if (child.exitCode === null && child.signalCode === null) {
    const exit = once(child, "exit");
    child.kill("SIGTERM");
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exit;
    clearTimeout(timeout);
  }
  backendLog.end();
  db.close();
}
