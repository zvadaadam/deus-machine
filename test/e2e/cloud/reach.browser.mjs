/* global window */
// A cloud workspace stops behaving as if it were on this computer. The real backend
// and web app, a scripted platform (./platform.mjs), a real local worktree beside it.
//   - Rule 2: in a cloud chat an internet link opens in the person's browser and a
//     localhost link in the cloud computer's preview, never this computer's localhost.
//   - Rule 1: no "Open in Last Editor" or ⌘O for a cloud workspace; the `/` menu lists
//     nothing from this computer's folders; the Agent tab says the configuration here
//     does not apply. The same `/` menu in the local workspace lists its folder's skill.
//   - "New Workspace from…" is not offered from the cloud.
//   - With the window on this computer, a reply finishing in the cloud puts a dot on the
//     header's trigger and on the cloud's row.
// Run: node --import tsx test/e2e/cloud/reach.browser.mjs   (part of bun run test:e2e:cloud)
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { createServer } from "vite";
import { chromium } from "playwright";
import { SCHEMA_SQL } from "../../../shared/schema.ts";
import { pause, startPlatform, textPart, until } from "./platform.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const output = path.join(root, ".context/cloud-e2e/reach");
const shots = path.join(root, ".context/shots/cloud-reach");
await mkdir(output, { recursive: true });
await mkdir(shots, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const check = (name, details) => console.log(`PASS: ${name}`, details ?? "");

const repository = crypto.randomUUID();
const cloudWorkspace = crypto.randomUUID();
const cloudSession = crypto.randomUUID();
const localWorkspace = crypto.randomUUID();
const localSession = crypto.randomUUID();
const PROVIDER = "ses_reach";
const PROVIDER_WORKSPACE = "wsp_reach";
const ORG = "org_reach";
const TEMPLATE = "https://{{port}}-reach.sandbox.test";
const LOCAL_SKILL = "worktree-only-skill";
// What the backend asks the platform for that this journey does not serve (answered
// 404); a request not listed here fails the run.
const UNSERVED = {
  "GET /models": "the platform's model lists, for the composer's picker",
  "GET /dashboard/orgs": "the account's organizations, read when credentials arrive",
  [`GET /workspaces/${PROVIDER_WORKSPACE}`]: "the workspace summary, opening the workspace",
  [`GET /sessions/${PROVIDER}`]: "the session, for the simulator's context",
};
const T = Date.now() - 120_000;
const text = (...args) => textPart(PROVIDER, ...args);

// ---- The scripted platform: a chat whose reply holds an internet and a localhost link --
const REPLY =
  "Read [the docs](https://example.com/docs) and open [the preview](http://localhost:5173/dashboard?tab=1) to see it.";
const history = [
  {
    id: "m_user_1",
    messageIndex: 0,
    sessionId: PROVIDER,
    turnId: "turn_old",
    outputIndex: 1,
    role: "user",
    createdAt: T,
    parts: [text("p_user_1", "m_user_1", "Where can I see it?")],
  },
  {
    id: "m_agent_1",
    messageIndex: 1,
    sessionId: PROVIDER,
    turnId: "turn_old",
    outputIndex: 2,
    role: "assistant",
    createdAt: T + 1000,
    parts: [text("p_agent_1", "m_agent_1", REPLY)],
  },
];
let currentTurn = null;
const platform = await startPlatform({
  bearer: "bearer-reach",
  sessions: [PROVIDER],
  snapshot: (id) => ({
    type: "session.snapshot",
    state: {
      sessionId: id,
      organizationId: ORG,
      workspaceId: PROVIDER_WORKSPACE,
      status: "ready",
      sandboxUrlTemplate: TEMPLATE,
      currentTurnId: currentTurn,
    },
    messages: history,
    events: [],
  }),
});
const send = (frame) => platform.send(PROVIDER, frame);

// ---- This computer: a project with a real worktree, a local and a cloud workspace ------
const repo = path.join(directory, "repository");
await mkdir(repo);
const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
git("init", "-b", "main");
git(
  "-c",
  "user.email=e2e@deus.test",
  "-c",
  "user.name=e2e",
  "commit",
  "--allow-empty",
  "-m",
  "init"
);
git("worktree", "add", "-b", "local-reach", path.join(repo, ".deus", "local-reach"));
// A skill in the worktree's own folder: the local `/` menu must list it, the cloud one not.
const skillDir = path.join(repo, ".deus", "local-reach", ".claude", "skills", LOCAL_SKILL);
await mkdir(skillDir, { recursive: true });
await writeFile(
  path.join(skillDir, "SKILL.md"),
  `---\nname: ${LOCAL_SKILL}\ndescription: Only in this computer's worktree\n---\nBody.\n`
);

const db = new Database(path.join(directory, "deus.db"));
db.exec(SCHEMA_SQL);
db.pragma("journal_mode = WAL");
db.prepare("INSERT INTO repositories (id, name, root_path) VALUES (?, 'Reach', ?)").run(
  repository,
  repo
);
db.prepare(
  "INSERT INTO workspaces (id, repository_id, slug, title, state, setup_status, current_session_id, git_branch, git_target_branch, kind, provider_workspace_id) VALUES (?, ?, 'cloud-reach', 'Cloud reach', 'ready', 'completed', ?, 'cloud-reach', 'main', 'cloud', ?)"
).run(cloudWorkspace, repository, cloudSession, PROVIDER_WORKSPACE);
db.prepare(
  "INSERT INTO sessions (id, workspace_id, agent_harness, status, provider_session_id) VALUES (?, ?, 'claude-code', 'idle', ?)"
).run(cloudSession, cloudWorkspace, PROVIDER);
db.prepare(
  "INSERT INTO workspaces (id, repository_id, slug, title, state, setup_status, current_session_id, git_branch, git_target_branch, kind) VALUES (?, ?, 'local-reach', 'Local reach', 'ready', 'completed', ?, 'local-reach', 'main', 'worktree')"
).run(localWorkspace, repository, localSession);
db.prepare(
  "INSERT INTO sessions (id, workspace_id, agent_harness, status) VALUES (?, ?, 'claude-code', 'idle')"
).run(localSession, localWorkspace);
await writeFile(
  path.join(directory, "preferences.json"),
  JSON.stringify({
    onboarding_completed: true,
    analytics_enabled: false,
    remote_access_enabled: false,
    theme: "dark",
    // This computer's own browser is off: the cloud preview must not depend on it.
    experimental_browser: false,
  })
);
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
    AGNT_API_KEY: "agnt_sk_reach",
    DEUS_CLOUD_AGNT_API_KEY: "agnt_sk_reach",
    AUTH_TOKEN: "desktop-reach-token",
  },
});
child.stdout.pipe(log);
child.stderr.pipe(log);
let vite, browser;
const errors = [];

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
  const handed = await fetch(`http://127.0.0.1:${port}/api/settings/cloud/credentials`, {
    method: "POST",
    headers: { authorization: "Bearer desktop-reach-token", "content-type": "application/json" },
    body: JSON.stringify({ deusCloudSessionToken: "bearer-reach" }),
  });
  assert.equal(handed.status, 200, await handed.text());

  vite = await createServer({
    configFile: path.join(root, "apps/web/vite.config.ts"),
    cacheDir: path.join(directory, "vite-cache"),
    logLevel: "error",
    define: { "import.meta.env.VITE_BACKEND_PORT": JSON.stringify(String(port)) },
    server: { host: "127.0.0.1", port: 0, hmr: false, fs: { allow: [root] } },
  });
  await vite.listen();
  const appUrl = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.on("pageerror", (error) => errors.push(error.message));
  // The person's own browser, as the page sees it: every address it is asked to open.
  await page.addInitScript(() => {
    window.__opened = [];
    window.open = (url) => {
      window.__opened.push(String(url));
      return null;
    };
  });
  // The cloud computer's preview address answers, so the frame has a page to show.
  await page.route("https://*.reach.sandbox.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<h1>cloud preview</h1>" })
  );
  const opened = () => page.evaluate(() => window.__opened);
  const composer = () => page.locator('[contenteditable="true"], textarea').first();

  // 1. On this computer: the `/` menu lists the worktree's own skill.
  await page.goto(`${appUrl}s/local/w/${localWorkspace}`, { timeout: 120_000 });
  await page.getByText("Local reach", { exact: true }).first().waitFor();
  await composer().click();
  await page.keyboard.type(`/${LOCAL_SKILL.slice(0, 8)}`);
  await page.getByText(LOCAL_SKILL).first().waitFor();
  await page.keyboard.press("Escape");
  await composer().fill("");
  check("the local `/` menu lists the skill in the workspace's own folder");

  // 2. The cloud chat. Rule 2: an internet link opens in the person's browser.
  await page.goto(`${appUrl}s/local/w/${cloudWorkspace}`);
  await page.getByText("Cloud reach", { exact: true }).first().waitFor();
  await page.getByRole("link", { name: "the docs" }).click();
  await until("the internet link to open", async () =>
    (await opened()).includes("https://example.com/docs")
  );
  check("an internet link in a cloud chat opens in the person's browser");

  // A localhost link is on the cloud computer: its preview, at that port and path, with
  // this computer's own browser setting off and in a plain browser.
  await page.getByRole("link", { name: "the preview" }).click();
  const frame = page.locator('iframe[title="Cloud computer preview"]');
  await frame.waitFor();
  // The panel opens on its stored port and takes the link's a moment later.
  await until(
    "the preview to show the link's port and path",
    async () =>
      (await frame.getAttribute("src")) === "https://5173-reach.sandbox.test/dashboard?tab=1"
  );
  assert.ok(
    !(await opened()).some((url) => url.includes("localhost")),
    "this computer's localhost was never opened"
  );
  await page.screenshot({ path: path.join(shots, "1-localhost-in-cloud-preview.png") });
  // The card's "Open in External Browser" follows the same rule: the preview's address.
  await page.getByRole("button", { name: /Choose open target for localhost:5173/ }).hover();
  await page.getByRole("menuitem", { name: "Open in External Browser" }).click();
  await until("the card's external open", async () =>
    (await opened()).includes("https://5173-reach.sandbox.test/dashboard?tab=1")
  );
  await page.keyboard.press("Escape");
  check(
    "a localhost link opens the cloud computer's preview at port 5173 and its path; the card's external open is the preview's address"
  );

  // 3. Rule 1: nothing offers this computer's folder or a local workspace from here.
  const url = page.url();
  await page.keyboard.press("Meta+o");
  await pause(300);
  assert.equal(page.url(), url, "⌘O changed nothing");
  assert.equal(context.pages().length, 1, "⌘O opened nothing");
  await page.keyboard.press("Meta+k");
  const search = page.getByPlaceholder(/command|search/i).first();
  await search.waitFor();
  await search.fill("Open in Last Editor");
  await pause(200);
  assert.equal(await page.getByText("Open in Last Editor").count(), 0, "no Open in Last Editor");
  await search.fill("New Workspace from");
  await pause(200);
  assert.equal(await page.getByText("New Workspace from…").count(), 0, "no New Workspace from…");
  await page.keyboard.press("Escape");
  check("⌘O does nothing visible; the palette has no Open in Last Editor or New Workspace from…");

  // An empty `/` shows nothing when there is nothing to list: ask for the local skill by name.
  await composer().click();
  await page.keyboard.type(`/${LOCAL_SKILL.slice(0, 8)}`);
  await page.getByText("No matching skills or commands").waitFor();
  assert.equal(await page.getByText(LOCAL_SKILL).count(), 0, "no skill from this computer");
  await page.keyboard.press("Escape");
  await composer().fill("");
  check("the cloud `/` menu lists nothing from this computer's folders");

  await page.getByRole("tab", { name: "Agent" }).click();
  await page.getByText("This workspace's agent runs in the cloud").waitFor();
  await page.screenshot({ path: path.join(shots, "2-agent-tab-cloud.png") });
  check("the Agent tab says in one line that this computer's configuration does not apply");

  // A message the platform refuses (the account must be reconnected) is not lost: it is
  // back in the composer, and the card says the sentence with the action that helps.
  const refusedText = "Reply with exactly one word: ready";
  await composer().click();
  await page.keyboard.type(refusedText);
  await page.keyboard.press("Enter");
  const refusedSend = await until("the refused message.send", () =>
    platform.commands(PROVIDER).find((c) => c.type === "message.send" && c.text === refusedText)
  );
  send({
    type: "error",
    code: "MESSAGE_SEND_FAILED",
    message:
      "PROVIDER_ACCOUNT_RECONNECT_REQUIRED: Your default Claude account must be reconnected in Settings → AI Providers, or choose another default.",
    messageId: refusedSend.messageId,
  });
  const card = page.getByRole("alert").filter({ hasText: "must be reconnected" });
  await card.waitFor();
  await until("the refused message back in the composer", async () =>
    (await composer().evaluate((el) => el.value ?? el.textContent)).includes(refusedText)
  );
  const cardText = await card.innerText();
  assert.ok(!/MESSAGE_SEND_FAILED|PROVIDER_ACCOUNT_RECONNECT_REQUIRED/.test(cardText), cardText);
  assert.equal(await card.getByRole("button", { name: "Open AI Providers" }).count(), 1);
  assert.equal(await card.getByRole("button", { name: "Retry in new chat" }).count(), 0);
  await page.screenshot({ path: path.join(shots, "2b-refused-send.png") });
  await card.getByRole("button", { name: "Open AI Providers" }).click();
  await page.getByRole("heading", { name: "AI Providers" }).first().waitFor();
  await page.keyboard.press("Escape");
  await page.goto(`${appUrl}s/local/w/${cloudWorkspace}`);
  await page.getByText("Cloud reach", { exact: true }).first().waitFor();
  await composer().fill("");
  check(
    "a send the platform refused is back in the composer; the card reads the sentence, offers Open AI Providers and no retry"
  );

  // 4. The window on this computer (⌃1); a reply finishes in the cloud.
  await page.keyboard.press("Control+Digit1");
  await page.getByText("Local reach", { exact: true }).first().waitFor();
  const trigger = page.getByRole("button", { name: /switch where workspaces run/ });
  const triggerDot = trigger.locator('[data-slot="place-activity"]');
  assert.equal(await triggerDot.count(), 0, "no activity elsewhere yet");
  // A turn started from another device: the backend learns it from the platform's
  // snapshot when it attaches again (a turn.started alone does not mark the chat working).
  const at = { sessionId: PROVIDER, turnId: "turn_elsewhere" };
  const now = () => Date.now();
  currentTurn = at.turnId;
  const sockets = platform.socketsFor(PROVIDER).length;
  platform.live(PROVIDER).ws.close(1011, "Injected outage");
  await until(
    "the backend to attach again",
    () => platform.socketsFor(PROVIDER).length > sockets && platform.live(PROVIDER)
  );
  await triggerDot.and(page.locator('[data-activity="working"]')).waitFor();
  check("a turn working in the cloud puts a working dot on the trigger");
  send({
    type: "message.started",
    ...at,
    messageId: "m_agent_2",
    messageIndex: 2,
    outputIndex: 3,
    role: "assistant",
    timestamp: now(),
  });
  send({
    type: "message.part",
    ...at,
    messageId: "m_agent_2",
    outputIndex: 3,
    partIndex: 0,
    part: text("p_agent_2", "m_agent_2", "Done in the cloud."),
    timestamp: now(),
  });
  send({ type: "message.ended", ...at, messageId: "m_agent_2", timestamp: now() });
  send({ type: "turn.ended", ...at, stopReason: "end_turn", timestamp: now() });
  await triggerDot.and(page.locator('[data-activity="unread"]')).waitFor();
  await trigger.click();
  const cloudRow = page.getByRole("menuitem", { name: /Deus Cloud/ });
  await cloudRow.locator('[data-slot="place-activity"][data-activity="unread"]').waitFor();
  await pause(400); // the menu's opening animation
  await page.screenshot({ path: path.join(shots, "3-activity-dot.png") });
  await page.keyboard.press("Escape");
  check("the reply that finished in the cloud shows an unread dot on the trigger and its row");

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
  console.error("unserved", [...new Set(platform.unserved)]);
  console.error("page errors", errors);
  try {
    console.error(
      "cloud session",
      db.prepare("SELECT status FROM sessions WHERE id = ?").get(cloudSession)
    );
    const page = browser?.contexts()[0]?.pages()[0];
    console.error(
      "trigger",
      await page
        ?.getByRole("button", { name: /switch where workspaces run/ })
        .evaluate((el) => el.outerHTML.slice(0, 600))
    );
  } catch {
    // diagnostics only
  }
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
  setTimeout(() => process.exit(process.exitCode ?? 0), 500);
}
