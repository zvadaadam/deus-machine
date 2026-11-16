/* global window */
// A cloud workspace on the direct lane: the real web app in its hosted mode
// (`VITE_CLOUD_DIRECT=1`), with no Mac backend. The browser talks to the platform
// itself; the platform is scripted (./platform.mjs) on loopback. No sandbox, no model call.
// Run: bun run test:e2e:cloud   (or node --import tsx test/e2e/cloud/direct-lane.browser.mjs)
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";
import { pause, scriptedTurn, startPlatform, textPart, until } from "./platform.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const output = path.join(root, ".context/cloud-e2e/direct-lane");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const check = (name, details) => console.log(`PASS: ${name}`, details ?? "");

const ORG = "org_smoke";
const ORG_NAME = "Smoke Labs";
// A second organization of the same account, with a session of its own.
const ORG2 = "org_second";
const ORG2_NAME = "Second Lab";
const SESSION = "ses_direct_smoke";
const SESSION2 = "ses_direct_second";
const WORKSPACE = "wsp_direct_smoke";
// What the hosted app asks the platform (or Deus Cloud) for that this journey does
// not serve. None today; a request that appears fails the run until it is listed here.
const UNSERVED = {};
const T = Date.now() - 120_000;
const text = (...args) => textPart(SESSION, ...args);

const history = [
  {
    id: "m_user_1",
    messageIndex: 0,
    sessionId: SESSION,
    turnId: "turn_old",
    outputIndex: 1,
    role: "user",
    createdAt: T,
    parts: [text("p_user_1", "m_user_1", "What does the smoke check?")],
  },
  {
    id: "m_agent_1",
    messageIndex: 1,
    sessionId: SESSION,
    turnId: "turn_old",
    outputIndex: 2,
    role: "assistant",
    createdAt: T + 1000,
    parts: [
      text("p_agent_1", "m_agent_1", "It checks the hosted web against a scripted platform."),
    ],
  },
];
let running = false;
const platform = await startPlatform({
  bearer: "bearer-smoke",
  sessions: [SESSION],
  snapshot: () => ({
    type: "session.snapshot",
    state: {
      sessionId: SESSION,
      organizationId: ORG,
      workspaceId: WORKSPACE,
      status: "ready",
      sandboxUrlTemplate: "https://{{port}}-smoke.sandbox.test",
      currentTurnId: null,
    },
    messages: history,
    events: [],
  }),
  orgs: [
    { id: ORG, name: ORG_NAME, sessions: [SESSION], listSessions: () => sessionsIn(ORG) },
    { id: ORG2, name: ORG2_NAME, sessions: [SESSION2], listSessions: () => sessionsIn(ORG2) },
  ],
});
function sessionsIn(org) {
  if (org === ORG2) {
    return [
      {
        id: SESSION2,
        status: "idle",
        workspace_id: "wsp_direct_second",
        workspace_status: "running",
        sandbox_id: "sbx_second",
        title: "Second smoke",
        repo: "deus/second",
        branch: "second",
        harness: "claude-code",
        created_at: new Date(T).toISOString(),
        updated_at: new Date(T + 1000).toISOString(),
      },
    ];
  }
  return [
    {
      id: SESSION,
      status: running ? "running" : "idle",
      workspace_id: WORKSPACE,
      workspace_status: "running",
      sandbox_id: "sbx_smoke",
      title: "Direct smoke",
      repo: "deus/smoke",
      branch: "smoke",
      harness: "claude-code",
      created_at: new Date(T).toISOString(),
      updated_at: new Date(T + 1000).toISOString(),
    },
  ];
}
const send = (frame) => platform.send(SESSION, frame);
const lists = () => platform.requests.filter((r) => r === `GET /dashboard/orgs/${ORG}/sessions`);

let vite, browser;
const errors = [];
const consoleErrors = [];
try {
  vite = await createServer({
    configFile: path.join(root, "apps/web/vite.config.ts"),
    cacheDir: path.join(directory, "vite-cache"),
    logLevel: "error",
    define: {
      "import.meta.env.VITE_CLOUD_DIRECT": JSON.stringify("1"),
      "import.meta.env.VITE_AGNT_BASE_URL": JSON.stringify(platform.url),
      // Deus Cloud is not called on this path; pointed here so a new call is noticed.
      "import.meta.env.VITE_DEUS_CLOUD_URL": JSON.stringify(platform.url),
    },
    // No hot reload: a source edit during a run must not reload a page mid-journey.
    server: { host: "127.0.0.1", port: 0, hmr: false, fs: { allow: [root] } },
  });
  await vite.listen();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  // Signed in: the bearer the deus-web login leaves in sessionStorage.
  await context.addInitScript(() => sessionStorage.setItem("deus_cloud_session", "bearer-smoke"));
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  const count = (value) => page.getByText(value, { exact: true }).count();

  // 1. The hosted app boots signed in, lists the platform's session and opens it.
  // The first load waits for Vite to build the app, which is slow on a busy machine.
  await page.goto(vite.resolvedUrls.local[0], { timeout: 120_000 });
  await page.getByText("Direct smoke", { exact: true }).first().waitFor();
  check("the sidebar lists the session the platform reports");
  // The header's location menu lists the account's organizations (no "this computer"
  // here); the window is in the first, and the sidebar lists that organization's sessions.
  const header = page.getByRole("button", { name: /switch where workspaces run/ });
  const sidebar = page.locator('[data-slot="sidebar"]').first();
  // The trigger reads the organization's initial tile, then its name.
  const headerLabel = async () => (await header.innerText()).trim().split("\n").at(-1);
  const inOrganization = async (name, shown, hidden) => {
    await until(
      "the organization's name in the header",
      async () => (await headerLabel()) === name
    );
    await sidebar.getByText(shown, { exact: true }).waitFor();
    await sidebar.getByText(hidden, { exact: true }).waitFor({ state: "detached" });
  };
  await inOrganization(ORG_NAME, "Direct smoke", "Second smoke");
  const menu = page.getByRole("menu");
  const openMenu = async () => {
    await header.click();
    await menu.waitFor();
    await menu.getByRole("menuitem", { name: new RegExp(ORG2_NAME) }).waitFor();
  };
  await openMenu();
  const rows = await menu
    .getByRole("menuitem")
    .evaluateAll((es) => es.map((e) => e.innerText.trim().replace(/\s+/g, " ")));
  // Each organization row: its initial, its name, and the shortcut (⌃1 is the first here).
  assert.deepEqual(rows, [`S ${ORG_NAME}`, `S ${ORG2_NAME} ⌃2`, "Your computers", "Settings"]);
  assert.equal(await menu.locator(`svg[class*="lucide-check"]`).count(), 1, "one place is checked");
  await menu.evaluate((e) =>
    Promise.all(e.getAnimations({ subtree: true }).map((a) => a.finished))
  );
  await page.screenshot({ path: path.join(directory, "0-menu.png") });
  await mkdir(path.join(root, ".context/shots/org-menu"), { recursive: true });
  await page.screenshot({ path: path.join(root, ".context/shots/org-menu/hosted-web.png") });
  await menu.getByRole("menuitem", { name: new RegExp(ORG2_NAME) }).click();
  await menu.waitFor({ state: "detached" });
  await inOrganization(ORG2_NAME, "Second smoke", "Direct smoke");
  await page.keyboard.press("Control+1");
  await inOrganization(ORG_NAME, "Direct smoke", "Second smoke");
  await openMenu();
  assert.ok(
    await menu.getByRole("menuitem", { name: /Your computers/ }).isVisible(),
    "the menu leads to the account's computers"
  );
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  check(
    "the menu lists both organizations (no computer row), the sidebar lists the chosen one's sessions, Ctrl+1 and a row switch",
    { rows }
  );
  await page.getByText("Direct smoke", { exact: true }).first().click();
  await page.getByText("It checks the hosted web against a scripted platform.").waitFor();
  await page.getByText("What does the smoke check?").waitFor();
  const [first] = platform.socketsFor(SESSION);
  assert.equal(platform.sockets.length, 1, "one session socket");
  assert.equal(first.url.pathname, `/sessions/${SESSION}/ws`);
  assert.equal(first.url.searchParams.get("token"), "session-token-1");
  check("the transcript is the socket's snapshot, opened with a token minted from the web session");
  await page.screenshot({ path: path.join(directory, "1-snapshot.png") });

  // The app's own modules, the same instances the page runs (Vite serves one per URL).
  await page.evaluate(
    async (modules) => {
      const ws = await import(modules.ws);
      const { api } = await import(modules.api);
      window.smoke = { preview: [], simulator: [], tools: [] };
      ws.follow(api.cloudPreviewChanges, {}, (event) => window.smoke.preview.push(event));
      ws.follow(api.cloudSimulatorEvents, {}, (event) => window.smoke.simulator.push(event));
      ws.follow(api.toolRequests, {}, (event) => window.smoke.tools.push(event));
    },
    // Passed as values: they resolve in the browser, under Vite, not here.
    { ws: "/src/platform/ws/index.ts", api: `/@fs${path.join(root, "shared/api/index.ts")}` }
  );

  // 2. Frames with no place in the transcript reach whoever follows their stream.
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
    sessionId: SESSION,
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
  assert.equal(side.preview.at(-1).workspaceId, SESSION);
  assert.equal(side.preview.at(-1).template, "https://{{port}}-next.sandbox.test");
  assert.equal(side.simulator.at(-1).kind, "status");
  assert.equal(side.simulator.at(-1).workspaceId, SESSION);
  assert.equal(side.simulator.at(-1).data.streamUrl, "https://stream.test/device");
  check("the sandbox address and the simulator status reach their streams' followers");

  // 3. A prompt typed in the composer leaves on the session socket, once.
  const prompt = "Say hello from the smoke";
  await page.locator('[contenteditable="true"], textarea').first().click();
  await page.keyboard.type(prompt);
  await page.keyboard.press("Enter");
  const sent = await until("the message.send command", () =>
    platform.commands(SESSION).find((c) => c.type === "message.send")
  );
  assert.equal(sent.text, prompt);
  assert.equal(sent.idempotencyKey, sent.turnId);
  assert.ok(
    sent.options.harness && sent.options.model && sent.options.thinkingLevel,
    JSON.stringify(sent.options)
  );
  check(
    "the prompt left as one message.send naming its harness, model and thinking level",
    sent.options
  );

  // The platform admits the turn and streams the reply.
  running = true;
  const turn = scriptedTurn(platform, SESSION, sent);
  turn.start();
  await page.getByText("Hello from the scripted").waitFor();
  assert.equal(await page.getByText(turn.reply).count(), 0);
  await page.screenshot({ path: path.join(directory, "2-streaming.png") });
  check("the reply shows while it is still being typed");

  // 4. The agent asks; the card shows; the answer goes back on the same socket.
  turn.ask();
  await page.getByText(turn.question).first().waitFor();
  await page.screenshot({ path: path.join(directory, "3-question.png") });
  const asked = await page.evaluate(() => window.smoke.tools);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].type, "request");
  assert.equal(asked[0].request.sessionId, SESSION);
  await page.getByText("Blue", { exact: true }).first().click();
  const answer = await until(
    "the elicitation.respond command",
    () => platform.commands(SESSION).find((c) => c.type === "elicitation.respond"),
    10_000
  );
  assert.equal(answer.data.requestId, "ask_1");
  assert.equal(answer.data.sessionId, SESSION);
  assert.equal(answer.data.outcome.action, "accept", JSON.stringify(answer.data.outcome));
  check(
    "the question card showed and its answer went back as elicitation.respond",
    answer.data.outcome
  );
  turn.resolve(answer.data.outcome);

  // 5. The reply finishes and the turn ends; the session list is read again.
  turn.finishReply();
  const listsBefore = lists().length;
  running = false;
  turn.end();
  await page.getByText(turn.reply).waitFor();
  await until(
    "the session list to be read again at the turn's end",
    () => lists().length > listsBefore
  );
  assert.equal(await count(prompt), 1, "one bubble for the prompt (no second copy from the echo)");
  assert.equal(platform.commands(SESSION).filter((c) => c.type === "message.send").length, 1);
  await page.screenshot({ path: path.join(directory, "4-ended.png") });
  check("the turn ended with one prompt bubble, the whole reply, and the list read again");

  // 6. The socket drops; the app dials again with a fresh snapshot and shows each row once.
  history.push(...turn.rows());
  const before = platform.sockets.length;
  platform.live(SESSION).ws.close(1011, "Injected outage");
  await until(
    "a second session socket",
    () => platform.sockets.length > before && platform.live(SESSION)
  );
  await pause(800);
  for (const row of [
    "What does the smoke check?",
    "It checks the hosted web against a scripted platform.",
    prompt,
    turn.reply,
  ]) {
    assert.equal(await count(row), 1, `"${row}" is shown once after the reconnect`);
  }
  await page.screenshot({ path: path.join(directory, "5-reconnected.png") });
  check("after a dropped socket the transcript is whole, each row once", {
    sockets: platform.sockets.length,
    tokens: platform.tokens,
  });

  assert.deepEqual(errors, [], "no page errors");
  assert.deepEqual(
    [...new Set(platform.unserved)].sort(),
    Object.keys(UNSERVED).sort(),
    "the app asked the platform only for what this journey serves or lists as unserved"
  );
  check("no page errors, and the platform was asked for nothing unexpected");
  console.log("ALL PASS");
} catch (error) {
  console.error("FAILED", error);
  console.error("platform requests", [...new Set(platform.requests)]);
  console.error("unserved", [...new Set(platform.unserved)]);
  console.error(
    "commands",
    platform.commands(SESSION).map((c) => c.type)
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
  platform.close();
  console.log("evidence", directory);
}
