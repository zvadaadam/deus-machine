/* global window */
// A cloud workspace on the Mac lane. The real backend holds the platform's session
// socket (the cloud driver) and the real web app follows the backend's streams.
// Only the platform is scripted (./platform.mjs). No sandbox, no model call.
// Run: bun run test:e2e:cloud   (or node --import tsx test/e2e/cloud/mac-lane.browser.mjs)
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { createServer } from "vite";
import { chromium } from "playwright";
import { SCHEMA_SQL } from "../../../shared/schema.ts";
import { pause, scriptedTurn, startPlatform, textPart, until } from "./platform.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const output = path.join(root, ".context/cloud-e2e/mac-lane");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const check = (name, details) => console.log(`PASS: ${name}`, details ?? "");

const repository = crypto.randomUUID();
const workspace = crypto.randomUUID();
const session = crypto.randomUUID();
const PROVIDER = "ses_mac_smoke";
const PROVIDER_WORKSPACE = "wsp_mac_smoke";
const ORG = "org_smoke";
// A second cloud workspace, for a client to be on while the first one is typing.
const elsewhere = crypto.randomUUID();
const elsewhereSession = crypto.randomUUID();
const ELSE = "ses_mac_else";
const ELSE_WORKSPACE = "wsp_mac_else";
// What the backend asks the platform for that this journey does not serve. Each is
// answered 404 and the backend carries on; a request not listed here fails the run.
const UNSERVED = {
  "GET /models": "the platform's model lists, for the composer's picker",
  "GET /dashboard/orgs":
    "the account's organizations (cloudOrganizations), read when credentials arrive",
  [`GET /workspaces/${PROVIDER_WORKSPACE}`]: "the workspace summary, opening the workspace",
  [`GET /workspaces/${ELSE_WORKSPACE}`]: "the same, for the second workspace",
  [`GET /sessions/${PROVIDER}`]: "the session, for the simulator's context",
  [`GET /sessions/${ELSE}`]: "the same, for the second session",
};
// The app's modules a page imports to reach its own socket client and cache. Passed
// to the page as values: they resolve in the browser, under Vite, not here.
const WS_MODULE = "/src/platform/ws/index.ts";
const CACHE_MODULE = "/src/shared/api/queryClient.ts";
const T = Date.now() - 120_000;
const text = (...args) => textPart(PROVIDER, ...args);

// ---- The scripted platform ---------------------------------------------------
const history = [
  {
    id: "m_user_1",
    messageIndex: 0,
    sessionId: PROVIDER,
    turnId: "turn_old",
    outputIndex: 1,
    role: "user",
    createdAt: T,
    parts: [text("p_user_1", "m_user_1", "What does the Mac lane smoke check?")],
  },
  {
    id: "m_agent_1",
    messageIndex: 1,
    sessionId: PROVIDER,
    turnId: "turn_old",
    outputIndex: 2,
    role: "assistant",
    createdAt: T + 1000,
    parts: [
      text(
        "p_agent_1",
        "m_agent_1",
        "It checks the backend's cloud driver against a scripted platform."
      ),
    ],
  },
];
let currentTurn = null;
const platform = await startPlatform({
  bearer: "bearer-smoke",
  sessions: [PROVIDER, ELSE],
  snapshot: (id) => ({
    type: "session.snapshot",
    state: {
      sessionId: id,
      organizationId: ORG,
      workspaceId: id === PROVIDER ? PROVIDER_WORKSPACE : ELSE_WORKSPACE,
      status: "ready",
      sandboxUrlTemplate: "https://{{port}}-smoke.sandbox.test",
      currentTurnId: id === PROVIDER ? currentTurn : null,
    },
    messages: id === PROVIDER ? history : [],
    events: [],
  }),
});
const send = (frame) => platform.send(PROVIDER, frame);

// ---- This computer: a database with two cloud workspaces, and the real backend --
const repo = path.join(directory, "repository");
await mkdir(repo);
execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "pipe" });
const db = new Database(path.join(directory, "deus.db"));
db.exec(SCHEMA_SQL);
db.pragma("journal_mode = WAL");
db.prepare("INSERT INTO repositories (id, name, root_path) VALUES (?, 'Smoke', ?)").run(
  repository,
  repo
);
const insertWorkspace = db.prepare(
  "INSERT INTO workspaces (id, repository_id, slug, title, state, setup_status, current_session_id, git_branch, git_target_branch, kind, provider_workspace_id) VALUES (?, ?, ?, ?, 'ready', 'completed', ?, ?, 'main', 'cloud', ?)"
);
const insertSession = db.prepare(
  "INSERT INTO sessions (id, workspace_id, agent_harness, status, provider_session_id) VALUES (?, ?, 'claude-code', 'idle', ?)"
);
insertWorkspace.run(
  workspace,
  repository,
  "cloud-smoke",
  "Mac lane smoke",
  session,
  "smoke",
  PROVIDER_WORKSPACE
);
insertSession.run(session, workspace, PROVIDER);
insertWorkspace.run(
  elsewhere,
  repository,
  "cloud-else",
  "Elsewhere",
  elsewhereSession,
  "else",
  ELSE_WORKSPACE
);
insertSession.run(elsewhereSession, elsewhere, ELSE);
await writeFile(
  path.join(directory, "preferences.json"),
  JSON.stringify({
    onboarding_completed: true,
    analytics_enabled: false,
    remote_access_enabled: false,
    theme: "dark",
  })
);
// The platform is the only cloud this backend may reach: no Deus Cloud, no local preset.
const env = { ...process.env };
delete env.DEUS_CLOUD_URL;
delete env.DEUS_CLOUD_ENV;
const log = createWriteStream(path.join(directory, "backend.log"));
const child = spawn(process.execPath, ["--import", "tsx", "apps/backend/src/server.ts"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...env,
    PORT: "0",
    DATABASE_PATH: path.join(directory, "deus.db"),
    TSX_TSCONFIG_PATH: path.join(root, "apps/backend/tsconfig.json"),
    AGNT_BASE_URL: platform.url,
    DEUS_CLOUD_AGNT_URL: platform.url,
    AGNT_API_KEY: "agnt_sk_smoke",
    DEUS_CLOUD_AGNT_API_KEY: "agnt_sk_smoke",
    AUTH_TOKEN: "desktop-smoke-token",
  },
});
child.stdout.pipe(log);
child.stderr.pipe(log);
let vite, browser;
const errors = [];
const consoleErrors = [];

try {
  const port = await new Promise((resolve, reject) => {
    let started = "";
    const timeout = setTimeout(() => reject(new Error("backend startup timed out")), 90_000);
    child.once("exit", (code) => reject(new Error(`backend exited ${code}`)));
    child.stdout.on("data", (data) => {
      started += String(data);
      const match = started.match(/^\[BACKEND_PORT\](\d+)$/m);
      if (match) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    });
  });
  // What the desktop app does after sign-in: hand the backend the account's session.
  const handed = await fetch(`http://127.0.0.1:${port}/api/settings/cloud/credentials`, {
    method: "POST",
    headers: { authorization: "Bearer desktop-smoke-token", "content-type": "application/json" },
    body: JSON.stringify({ deusCloudSessionToken: "bearer-smoke" }),
  });
  assert.equal(handed.status, 200, await handed.text());

  vite = await createServer({
    configFile: path.join(root, "apps/web/vite.config.ts"),
    cacheDir: path.join(directory, "vite-cache"),
    logLevel: "error",
    define: { "import.meta.env.VITE_BACKEND_PORT": JSON.stringify(String(port)) },
    // No hot reload: a source edit during a run must not reload a page mid-journey.
    server: { host: "127.0.0.1", port: 0, hmr: false, fs: { allow: [root] } },
  });
  await vite.listen();
  const appUrl = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true });
  const openPage = async (name) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.on("pageerror", (error) => errors.push(`${name}: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(`${name}: ${message.text()}`);
    });
    return { context, page };
  };
  const { page } = await openPage("first");
  const count = (value) => page.getByText(value, { exact: true }).count();

  // 1. Opening the cloud workspace connects the backend to the platform; the transcript is its snapshot.
  // The first load waits for Vite to build the app, which is slow on a busy machine.
  await page.goto(`${appUrl}s/local/w/${workspace}`, { timeout: 120_000 });
  await page.getByText("Mac lane smoke", { exact: true }).first().waitFor();
  await page
    .getByText("It checks the backend's cloud driver against a scripted platform.")
    .waitFor();
  await page.getByText("What does the Mac lane smoke check?").waitFor();
  assert.equal(platform.socketsFor(PROVIDER).length, 1, "one platform socket, held by the backend");
  assert.equal(platform.socketsFor(PROVIDER)[0].url.searchParams.get("token"), "session-token-1");
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM messages WHERE session_id = ?").get(session).n,
    2
  );
  check(
    "opening the workspace connected the backend, which stored and showed the platform's transcript"
  );
  await page.screenshot({ path: path.join(directory, "1-snapshot.png") });

  // The app's own modules, the same instances the page runs (Vite serves one per URL).
  await page.evaluate(
    async (modules) => {
      const ws = await import(modules.ws);
      const { api } = await import(modules.api);
      window.smoke = { preview: [], simulator: [], tools: [], environment: [] };
      ws.follow(api.cloudPreviewChanges, {}, (event) => window.smoke.preview.push(event));
      ws.follow(api.cloudSimulatorEvents, {}, (event) => window.smoke.simulator.push(event));
      ws.follow(api.toolRequests, {}, (event) => window.smoke.tools.push(event));
      ws.follow(api.cloudEnvironment, {}, (event) => window.smoke.environment.push(event));
      window.smokeRead = (name, input) => ws.call(api[name], input);
    },
    { ws: WS_MODULE, api: `/@fs${path.join(root, "shared/api/index.ts")}` }
  );
  await pause(300);

  // 2. Frames with no place in the transcript reach the page through the backend's streams.
  assert.equal(
    await page.evaluate((id) => window.smokeRead("cloudPreview", { workspaceId: id }), workspace),
    "https://{{port}}-smoke.sandbox.test",
    "the snapshot's sandbox address is readable"
  );
  send({
    type: "workspace.state",
    data: {
      status: "running",
      sandboxId: "sbx_smoke",
      sandboxUrlTemplate: "https://{{port}}-next.sandbox.test",
    },
  });
  send({
    type: "simulator.status",
    sessionId: PROVIDER,
    status: "ready",
    platform: "ios",
    streamUrl: "https://stream.test/device",
    timestamp: new Date().toISOString(),
  });
  const side = await until("the preview and simulator events", () =>
    page.evaluate(() =>
      window.smoke.preview.length && window.smoke.simulator.length ? window.smoke : null
    )
  );
  assert.equal(side.preview.at(-1).workspaceId, workspace);
  assert.equal(side.preview.at(-1).template, "https://{{port}}-next.sandbox.test");
  assert.equal(side.simulator.at(-1).workspaceId, workspace);
  assert.equal(side.simulator.at(-1).kind, "status");
  assert.equal(side.simulator.at(-1).data.streamUrl, "https://stream.test/device");
  check(
    "the sandbox address and the simulator status arrive on their streams, under this computer's ids"
  );

  // 3. A prompt typed in the composer becomes one message.send on the platform socket.
  const prompt = "Say hello from the Mac lane";
  await page.locator('[contenteditable="true"], textarea').first().click();
  await page.keyboard.type(prompt);
  await page.keyboard.press("Enter");
  const sent = await until("the message.send command", () =>
    platform.commands(PROVIDER).find((c) => c.type === "message.send")
  );
  assert.equal(sent.text, prompt);
  assert.ok(
    sent.options.harness && sent.options.model && sent.options.thinkingLevel,
    JSON.stringify(sent.options)
  );
  check("the prompt left the backend as one message.send", sent.options);

  const turn = scriptedTurn(platform, PROVIDER, sent);
  turn.start();
  await page.getByText("Hello from the scripted").waitFor();
  assert.equal(await page.getByText(turn.reply).count(), 0);
  await page.screenshot({ path: path.join(directory, "2-streaming.png") });
  check("the reply shows while it is still being typed");

  // 3b. A second client, elsewhere, while that reply is being typed. The platform says
  //     nothing more until these checks are over: whatever this client shows of the reply
  //     is what it was sent when it started following.
  const { context: second, page: page2 } = await openPage("second");
  const wire2 = { sent: [], received: [], current: undefined, forgetPosition: false };
  await page2.routeWebSocket(
    (url) => url.pathname === "/ws",
    (route) => {
      const server = route.connectToServer();
      wire2.current = { route, server };
      route.onMessage((raw) => {
        const frame = JSON.parse(String(raw));
        // As if the host could no longer say what this client missed (a restarted backend).
        if (
          wire2.forgetPosition &&
          frame.type === "q:subscribe" &&
          frame.resource === "sessionEvents" &&
          frame.after !== undefined
        ) {
          frame.after = Number.MAX_SAFE_INTEGER;
        }
        wire2.sent.push(frame);
        server.send(JSON.stringify(frame));
      });
      server.onMessage((raw) => {
        wire2.received.push(JSON.parse(String(raw)));
        route.send(raw);
      });
    }
  );
  const reads = () =>
    wire2.sent.filter(
      (f) => f.type === "q:request" && f.resource === "messages" && f.params?.sessionId === session
    );
  const answered = (request) =>
    wire2.received.some((f) => f.type === "q:response" && f.id === request.id);
  const resets = () => wire2.received.filter((f) => f.type === "q:reset").length;
  await page2.goto(`${appUrl}s/local/w/${elsewhere}`);
  await page2.getByText("Elsewhere", { exact: true }).first().waitFor();
  assert.equal(reads().length, 0, "the second client has not read the typing chat");
  // Pointing at the chat reads its page ahead, and follows it from that moment.
  await page2.getByText("Mac lane smoke", { exact: true }).first().hover();
  await until("the page read ahead on hover", () => reads().length === 1 && answered(reads()[0]));
  const followed = wire2.sent.findIndex(
    (f) =>
      f.type === "q:subscribe" && f.resource === "sessionEvents" && f.params?.sessionId === session
  );
  assert.ok(
    followed !== -1 && followed < wire2.sent.indexOf(reads()[0]),
    "it follows the chat before it asks for its page"
  );
  assert.equal(
    await page2.getByText("Hello from the scripted").count(),
    0,
    "the chat is not on screen yet"
  );
  await page2.getByText("Mac lane smoke", { exact: true }).first().click();
  await page2.getByText(prompt, { exact: true }).waitFor();
  await page2
    .getByText("Hello from the scripted")
    .waitFor({ timeout: 5_000 })
    .catch(() => {
      throw new Error("a chat opened after hovering does not show the reply typed so far");
    });
  await page2.screenshot({ path: path.join(directory, "3b-opened-after-hover.png") });
  check(
    "a chat pointed at and then opened mid-reply shows what was typed so far, with no new token"
  );

  // 3c. The host cannot say what this client missed: it is told to read again, and is sent
  //     the part being typed as it stands. The page it then reads holds that part as stored.
  wire2.forgetPosition = true;
  const before2 = { reads: reads().length, resets: resets() };
  await wire2.current.route.close({ code: 1011, reason: "Injected outage" });
  await wire2.current.server.close({ code: 1011, reason: "Injected outage" });
  await until("the reset", () => resets() > before2.resets);
  await until(
    "the page read the reset asked for",
    () => reads().length > before2.reads && answered(reads().at(-1))
  );
  wire2.forgetPosition = false;
  await pause(900);
  const cachedReply = await page2.evaluate(
    async ([id, cache]) => {
      const { queryClient } = await import(cache);
      const rows = queryClient.getQueryData(["sessions", "messages", id])?.messages ?? [];
      return rows
        .filter((m) => m.role === "assistant")
        .at(-1)
        ?.parts?.map((p) => `${p.state ?? ""}:${JSON.stringify(p.text ?? "")}`)
        .join("|");
    },
    [session, CACHE_MODULE]
  );
  await page2.screenshot({ path: path.join(directory, "3c-after-reset.png") });
  assert.equal(
    cachedReply,
    'streaming:"Hello from the scripted "',
    "after a reset, the page read must keep the reply typed so far"
  );
  assert.equal(
    await page2.getByText("Hello from the scripted").count(),
    1,
    "after a reset, the reply typed so far is shown once"
  );
  check("after a reset the reply typed so far is still shown once the page was read again", {
    reads: reads().length,
  });
  await second.close();

  // 4. The agent asks; the card shows; the answer goes back through the backend.
  turn.ask();
  await page.getByText(turn.question).first().waitFor();
  await page.screenshot({ path: path.join(directory, "3-question.png") });
  const asked = await page.evaluate(() => window.smoke.tools);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].type, "request");
  assert.equal(asked[0].request.sessionId, session);
  await page.getByText("Blue", { exact: true }).first().click();
  const answer = await until(
    "the elicitation.respond command",
    () => platform.commands(PROVIDER).find((c) => c.type === "elicitation.respond"),
    10_000
  );
  assert.equal(answer.data.requestId, "ask_1");
  assert.equal(answer.data.sessionId, PROVIDER);
  assert.equal(answer.data.outcome.action, "accept", JSON.stringify(answer.data.outcome));
  check(
    "the question card showed and its answer went back as elicitation.respond",
    answer.data.outcome
  );
  turn.resolve(answer.data.outcome);

  // 5. The reply finishes and the turn ends.
  turn.finishReply();
  turn.end();
  await page.getByText(turn.reply).waitFor();
  await until(
    "the session to be idle",
    () => db.prepare("SELECT status FROM sessions WHERE id = ?").get(session).status === "idle"
  );
  assert.equal(await count(prompt), 1, "one bubble for the prompt");
  assert.equal(platform.commands(PROVIDER).filter((c) => c.type === "message.send").length, 1);
  await page.screenshot({ path: path.join(directory, "4-ended.png") });
  check("the turn ended with one prompt bubble and the whole reply");

  // 6. What the page built from the stream is what a fresh read of the database returns.
  const compare = await page.evaluate(
    async ([id, cache]) => {
      const fresh = await window.smokeRead("messages", { sessionId: id });
      const { queryClient } = await import(cache);
      const cached = queryClient.getQueryData(["sessions", "messages", id]);
      const shape = (rows) =>
        (rows?.messages ?? []).map((m) => ({
          id: m.id,
          role: m.role,
          turn: m.turn_id,
          parts: (m.parts ?? []).map((p) => ({
            id: p.id,
            type: p.type,
            text: p.text,
            state: p.state,
          })),
        }));
      return { cached: shape(cached), fresh: shape(fresh) };
    },
    [session, CACHE_MODULE]
  );
  assert.equal(compare.fresh.length, 4);
  assert.deepEqual(compare.cached, compare.fresh, "the page equals a fresh read");
  check("the page built from the stream equals a fresh read of the database", {
    rows: compare.fresh.length,
  });

  // 7. The platform socket drops; the backend dials again and the page shows each row once.
  history.push(...turn.rows());
  const before = platform.socketsFor(PROVIDER).length;
  platform.live(PROVIDER).ws.close(1011, "Injected outage");
  await until(
    "a second platform socket",
    () => platform.socketsFor(PROVIDER).length > before && platform.live(PROVIDER)
  );
  await pause(1000);
  for (const row of [
    "What does the Mac lane smoke check?",
    "It checks the backend's cloud driver against a scripted platform.",
    prompt,
    turn.reply,
  ]) {
    assert.equal(await count(row), 1, `"${row}" is shown once after the platform reconnect`);
  }
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM messages WHERE session_id = ?").get(session).n,
    4
  );
  await page.screenshot({ path: path.join(directory, "5-reconnected.png") });
  check("after the platform socket dropped the transcript is whole, each row once", {
    sockets: platform.socketsFor(PROVIDER).length,
  });

  // 8. A reply is being typed on the platform (started from another device) when the
  //    backend attaches again: the snapshot holds the part as typed so far, and its
  //    tokens keep arriving. A client that opens the chat only then is sent the part
  //    as it stands, and the tokens after it extend it.
  const OTHER_TURN = "turn_other_device";
  const now = () => Date.now();
  history.push(
    {
      id: "m_user_3",
      messageIndex: 4,
      sessionId: PROVIDER,
      turnId: OTHER_TURN,
      outputIndex: 5,
      role: "user",
      createdAt: now(),
      parts: [text("p_user_3", "m_user_3", "Asked from another device")],
    },
    {
      id: "m_agent_3",
      messageIndex: 5,
      sessionId: PROVIDER,
      turnId: OTHER_TURN,
      outputIndex: 6,
      role: "assistant",
      createdAt: now(),
      parts: [text("p_agent_3", "m_agent_3", "Second reply, so ", "streaming")],
    }
  );
  currentTurn = OTHER_TURN;
  const before3 = platform.socketsFor(PROVIDER).length;
  platform.live(PROVIDER).ws.close(1011, "Injected outage");
  await until(
    "a third platform socket",
    () => platform.socketsFor(PROVIDER).length > before3 && platform.live(PROVIDER)
  );
  await page.getByText("Second reply, so").waitFor();
  const delta3 = (value) =>
    send({
      type: "message.part.delta",
      sessionId: PROVIDER,
      turnId: OTHER_TURN,
      messageId: "m_agent_3",
      outputIndex: 6,
      partIndex: 0,
      partId: "p_agent_3",
      delta: { type: "text", text: value },
      timestamp: now(),
    });
  delta3("far");
  await page.getByText("Second reply, so far").waitFor();
  const { context: third, page: page3 } = await openPage("third");
  await page3.goto(`${appUrl}s/local/w/${workspace}`);
  await page3.getByText("Asked from another device", { exact: true }).waitFor();
  await page3
    .getByText("Second reply, so far")
    .waitFor({ timeout: 5_000 })
    .catch(() => {
      throw new Error(
        "a client that opens a cloud chat restored mid-reply is not sent the part as it stands"
      );
    });
  await page3.screenshot({ path: path.join(directory, "8-opened-after-restore.png") });
  delta3(", and on");
  await page3
    .getByText("Second reply, so far, and on")
    .waitFor({ timeout: 5_000 })
    .catch(() => {
      throw new Error("the tokens after it do not extend the part for that client");
    });
  check(
    "a client that opens a cloud chat restored mid-reply shows the reply typed so far, and what follows"
  );
  await third.close();

  assert.deepEqual(errors, [], "no page errors");
  assert.deepEqual(
    [...new Set(platform.unserved)].sort(),
    Object.keys(UNSERVED).sort(),
    "the backend asked the platform only for what this journey serves or lists as unserved"
  );
  check("no page errors, and the platform was asked for nothing unexpected");
  console.log("ALL PASS");
} catch (error) {
  console.error("FAILED", error);
  console.error("platform requests", [...new Set(platform.requests)]);
  console.error("unserved", [...new Set(platform.unserved)]);
  console.error(
    "commands",
    platform.commands(PROVIDER).map((c) => c.type)
  );
  console.error("page errors", errors, "console errors", consoleErrors.slice(0, 10));
  try {
    const page = browser?.contexts()[0]?.pages()[0];
    await page?.screenshot({ path: path.join(directory, "failure.png") });
    console.error("UI", (await page?.locator("body").innerText())?.slice(0, 1500));
  } catch {
    // The page may already be gone; the error above is the finding.
  }
  process.exitCode = 1;
} finally {
  await browser?.close();
  await vite?.close();
  child.kill("SIGTERM");
  platform.close();
  db.close();
  console.log("evidence", directory);
  // The backend's handles can outlive its kill signal; the result is already decided.
  setTimeout(() => process.exit(process.exitCode ?? 0), 500);
}
