/* global window, document, requestAnimationFrame */
// Real app + real backend/SQLite + real git: where a workspace starts (Home,
// and nowhere else), a start that fails, is retried in place and is deleted,
// one that starts behind an unreachable remote, and one a previous backend
// left half started. Node 22, Bun dependencies and Playwright Chromium are
// required. The backend runs with no agent engine (AGENT_ALLOW_AGENTLESS), so
// no message can start a paid turn.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import Database from "better-sqlite3";
import { createServer } from "vite";
import { chromium } from "playwright";
import { SCHEMA_SQL } from "../../shared/schema.ts";
import { LOOPBACK_WEB_ORIGINS } from "../../shared/web-origins.ts";
import { connectBackend } from "./lib/operations.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const evidence = path.join(root, ".context/workspace-start");
await mkdir(evidence, { recursive: true });
const directory = await mkdtemp(path.join(evidence, "run-"));

// ── A project with one commit, a setup script slow enough to watch, and two rows.
const repo = path.join(directory, "project");
await mkdir(path.join(repo, ".deus"), { recursive: true });
const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" }).toString().trim();
git("init", "-q", "-b", "main");
git("config", "user.name", "Journey Test");
git("config", "user.email", "journey@example.test");
await writeFile(path.join(repo, "README.md"), "Workspace start journey\n");
await writeFile(
  path.join(repo, ".deus/environment.json"),
  JSON.stringify({ version: 1, setup: "sleep 1.5" })
);
git("add", ".");
git("commit", "-qm", "First commit");
const branches = () => git("branch", "--format=%(refname:short)").split("\n");
const checkout = (slug) => path.join(repo, ".deus", slug);

// What a backend that stopped mid-start leaves: a row still "initializing" and
// a worktree git has registered and locked.
git("worktree", "add", "-q", "-b", "journey-test/halley", checkout("halley"), "main");
git("worktree", "lock", "--reason", "initializing", checkout("halley"));

// A second project whose recorded default branch does not exist yet: a
// workspace started in it fails until the branch is made.
const launch = path.join(directory, "launch");
await mkdir(path.join(launch, ".deus"), { recursive: true });
const gitLaunch = (...args) =>
  execFileSync("git", args, { cwd: launch, stdio: "pipe" }).toString().trim();
gitLaunch("init", "-q", "-b", "main");
gitLaunch("config", "user.name", "Journey Test");
gitLaunch("config", "user.email", "journey@example.test");
await writeFile(path.join(launch, "README.md"), "Launch\n");
await writeFile(
  path.join(launch, ".deus/environment.json"),
  JSON.stringify({ version: 1, setup: "sleep 3" })
);
gitLaunch("add", ".");
gitLaunch("commit", "-qm", "First commit");

const repository = crypto.randomUUID(),
  launchRepository = crypto.randomUUID(),
  home = crypto.randomUUID(),
  homeSession = crypto.randomUUID(),
  interrupted = crypto.randomUUID();
const db = new Database(path.join(directory, "deus.db"));
db.exec(SCHEMA_SQL);
db.pragma("journal_mode = WAL");
db.prepare(
  "INSERT INTO repositories (id, name, root_path, git_default_branch) VALUES (?, 'project', ?, 'main')"
).run(repository, repo);
db.prepare(
  "INSERT INTO repositories (id, name, root_path, git_default_branch, sort_order) VALUES (?, 'launch', ?, 'develop', 1)"
).run(launchRepository, launch);
db.prepare(
  "INSERT INTO workspaces (id, repository_id, slug, title, state, current_session_id, git_branch, git_target_branch) VALUES (?, ?, 'home', 'Somewhere else', 'ready', ?, 'main', 'main')"
).run(home, repository, homeSession);
db.prepare(
  // Spoken to before (this agentless backend never stamps it itself).
  "INSERT INTO sessions (id, workspace_id, agent_harness, status, last_user_message_at) VALUES (?, ?, 'claude-code', 'idle', '2026-11-01T09:00:00Z')"
).run(homeSession, home);
db.prepare(
  "INSERT INTO workspaces (id, repository_id, slug, state, init_stage, git_branch, git_source_branch, git_target_branch) VALUES (?, ?, 'halley', 'initializing', 'worktree', 'journey-test/halley', 'main', 'main')"
).run(interrupted, repository);
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
    DEUS_USER_DATA_DIR: directory,
    DATABASE_PATH: path.join(directory, "deus.db"),
    // Never the login Keychain, and git never climbs out of the run into this checkout.
    DEUS_VAULT_NO_KEYCHAIN: "1",
    GIT_CEILING_DIRECTORIES: directory,
    // The web app this runner serves, at whatever port Vite takes.
    DEUS_WEB_ORIGINS: LOOPBACK_WEB_ORIGINS,
    TSX_TSCONFIG_PATH: path.join(root, "apps/backend/tsconfig.json"),
    AGENT_ALLOW_AGENTLESS: "1",
    AGNT_API_KEY: "",
    DEUS_CLOUD_AGNT_API_KEY: "",
  },
});
child.stdout.pipe(backendLog);
child.stderr.pipe(backendLog);

let vite, browser, slowOrigin, backend;
const errors = [],
  report = { checks: [], directory };
const check = (name, details = {}) => {
  report.checks.push({ name, ...details });
  console.log(`PASS: ${name}`);
};
const until = async (what, read, timeout = 20_000) => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

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
  // The backend's operations, as the app asks for them (lib/operations.mjs).
  backend = await connectBackend(`http://127.0.0.1:${port}`);
  const workspace = (workspaceId) => backend.read("workspace", { workspaceId });
  // Every workspace row, whatever its state, from the read the sidebar uses.
  const allWorkspaces = async () =>
    (await backend.read("workspaces", { state: "ready,initializing,error,archived" })).flatMap(
      (group) => group.workspaces
    );
  // What the backend says when it refuses, or null when it does not.
  const refusal = (asked) =>
    asked.then(
      () => null,
      (error) => error.message
    );

  // ── 1. The row the last backend abandoned.
  const abandoned = await workspace(interrupted);
  assert.equal(abandoned.state, "error");
  assert.equal(abandoned.error_message, "Deus closed before this workspace was ready.");
  await until("the half-made worktree to be removed", () => !existsSync(checkout("halley")));
  await until("its branch to be removed", () => !branches().includes("journey-test/halley"));
  assert(!git("worktree", "list").includes("halley"));
  check("A start the previous backend abandoned fails at startup and its locked worktree is gone");

  vite = await createServer({
    configFile: path.join(root, "apps/web/vite.config.ts"),
    cacheDir: path.join(directory, "vite-cache"),
    logLevel: "error",
    define: { "import.meta.env.VITE_BACKEND_PORT": JSON.stringify(String(port)) },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [root] } },
  });
  await vite.listen();
  const url = (id) => `${vite.resolvedUrls.local[0]}s/local/w/${id}`;
  browser = await chromium.launch({ headless: true });
  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
  });
  const mobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: "dark",
    isMobile: true,
    hasTouch: true,
  });
  const a = await desktop.newPage(),
    b = await mobile.newPage();
  const sent = [];
  for (const page of [a, b]) {
    page.setDefaultTimeout(20000);
    page.on("pageerror", (error) => errors.push(error.message));
  }
  a.on("websocket", (socket) =>
    socket.on("framesent", (frame) => {
      if (String(frame.payload).includes('"q:mutate"')) sent.push(String(frame.payload));
    })
  );
  // The app's own modules, as Vite serves them to the page (paths in the
  // browser, so they are data here, not imports of this file).
  const modules = {
    client: "/src/platform/ws/query-protocol-client.ts",
    pending: "/src/features/workspace/store/workspaceStartStore.ts",
    agents: "/src/shared/agents/index.ts",
  };
  const attach = async (page) => {
    await page.evaluate(async (modules) => {
      window.testClient = (await import(modules.client)).getRuntimeClient();
      window.pendingFirstMessages = (await import(modules.pending)).pendingFirstMessages;
      window.defaultModel = (await import(modules.agents)).DEFAULT_MODEL;
    }, modules);
    await page.waitForFunction(() => window.testClient.isConnected());
  };
  const create = async (params = {}) => {
    const started = Date.now();
    const { workspaceId } = await backend.write("createWorkspace", {
      repository_id: repository,
      ...params,
    });
    return { id: workspaceId, ackMs: Date.now() - started };
  };
  const panel = (page) => page.locator('[data-slot="workspace-start-state"]');
  const shot = async (page, name, settle = 600) => {
    await page.waitForTimeout(settle); // entering toasts and dialogs finish moving
    await page.screenshot({ path: path.join(evidence, `${name}.png`) });
  };
  const toast = (page, text) => page.locator("[data-sonner-toast]").filter({ hasText: text });
  const keep = (page, id, message) =>
    page.evaluate(
      ({ id, message }) =>
        window.pendingFirstMessages.set(id, { message, model: window.defaultModel }),
      { id, message }
    );

  const main = (page) => page.locator('[data-slot="main-content"]');
  const composer = (page) => page.getByLabel("Message to start a new workspace");
  // The chat's composer: on the start page before there is a chat, in the chat after.
  const startComposer = (page) => panel(page).locator('[data-slot="input-group"]');
  const chatComposer = (page) => main(page).locator('[data-slot="input-group"]');
  // Measures, not asserts: what sits at the bottom of the chat column on each
  // frame while the start page hands over to the chat.
  const watchBottom = (page) =>
    page.evaluate(() => {
      const log = (window.bottomLog = []);
      const t0 = performance.now();
      const read = () => {
        const main = document.querySelector('[data-slot="main-content"]');
        if (!main) return "nothing";
        if (main.querySelector('[data-slot="workspace-start-state"] [data-slot="input-group"]'))
          return "start composer";
        if (main.querySelector('[data-slot="input-group"]')) return "chat composer";
        const text = main.innerText;
        if (text.includes("Loading conversation…")) return "loading pill";
        if (text.includes("Start a chat to send messages.")) return "empty pill";
        return "nothing";
      };
      const frame = () => {
        const what = read();
        if (log.at(-1)?.what !== what) log.push({ what, at: Math.round(performance.now() - t0) });
        if (what !== "chat composer" || log.length === 1) requestAnimationFrame(frame);
        else window.bottomDone = true;
      };
      requestAnimationFrame(frame);
    });
  const readBottom = async (page) => {
    await page.waitForFunction(() => window.bottomDone, null, { timeout: 30_000 });
    return page.evaluate(() => window.bottomLog);
  };
  const sends = (text) =>
    sent.filter((frame) => frame.includes('"sendMessage"') && frame.includes(text)).length;
  const startLine = (page) => page.getByRole("status").filter({ hasText: "Workspace ready" });

  await a.goto(url(home));
  await b.goto(url(home));
  await Promise.all([attach(a), attach(b)]);

  // The abandoned one is shown as a failure that can be retried, not a spinner.
  await a.goto(url(interrupted));
  await attach(a);
  await panel(a).getByText("Deus closed before this workspace was ready.").waitFor();
  await panel(a).getByRole("button", { name: "Retry", exact: true }).waitFor();
  await shot(a, "interrupted");

  // ── 2. A workspace starts on Home, and nowhere else.
  // The sidebar's first row (a project with no workspaces has a row of the same name).
  await a.getByRole("button", { name: "New workspace", exact: true }).first().click();
  await a.getByText("What are we building?").waitFor();
  await composer(a).waitFor();
  // Ready to type: the composer has the focus.
  const focused = () =>
    a.waitForFunction(
      () =>
        document.activeElement?.getAttribute("aria-label") === "Message to start a new workspace",
      null,
      { timeout: 3000 }
    );
  await focused();
  // A project's "+" opens the same Home, with that project chosen.
  await a.goto(url(home));
  await attach(a);
  await a.getByRole("button", { name: "New workspace in launch", exact: true }).click();
  await a.getByText("What are we building?").waitFor();
  await main(a).getByRole("button", { name: "launch", exact: true }).waitFor();
  await focused();
  assert.equal(await a.getByRole("dialog").count(), 0, "nothing creates a workspace in a dialog");
  await shot(a, "home");
  check(
    "New workspace and a project's + both open Home, ready to type, with the project chosen; no dialog"
  );

  // ── 3. A start that fails, from the composer: the project's branch does not exist.
  await composer(a).fill("Add a dark mode toggle to the settings page");
  await composer(a).press("Enter");
  await panel(a).getByText("Workspace didn't start").waitFor();
  await panel(a).getByText('The branch "develop" does not exist in this project.').waitFor();
  assert.equal(await panel(a).getAttribute("data-state"), "failed");
  const failing = (await allWorkspaces()).find((row) => row.repository_id === launchRepository);
  assert.equal(failing.state, "error");
  assert(!existsSync(path.join(launch, ".deus", failing.slug)), "a failed start leaves no folder");
  assert.deepEqual(
    gitLaunch("branch", "--format=%(refname:short)").split("\n"),
    ["main"],
    "a failed start leaves no branch"
  );
  await a
    .locator(`[data-workspace-id="${failing.id}"]`)
    .getByText("Failed", { exact: true })
    .waitFor();
  // The message that was typed is kept, as the bubble it will be.
  const waiting = panel(a).locator('[data-slot="waiting-message"]');
  await waiting.getByText("Add a dark mode toggle to the settings page").waitFor();
  // A start that can be retried keeps the chat's composer, where the chat will have it.
  await startComposer(a).waitFor();
  await panel(a).getByRole("button", { name: "Details" }).click();
  await panel(a).getByText("invalid reference: develop").waitFor();
  // No chat can be opened in a workspace with no checkout: that would hide the failure.
  assert.equal(await a.getByRole("button", { name: "New chat tab" }).count(), 0);
  assert.equal(
    await refusal(backend.write("createSession", { workspaceId: failing.id })),
    "This workspace has not started yet, so it has no chats."
  );
  // Nor is there a branch to open a pull request from, or anything for the tools to show.
  assert.equal(await a.getByRole("button", { name: "Create PR" }).count(), 0);
  assert.equal(await a.locator('[data-slot="workspace-tool-header"]').count(), 0);
  await shot(a, "failed");
  await b.goto(url(failing.id));
  await attach(b);
  await panel(b).getByRole("button", { name: "Retry", exact: true }).waitFor();
  await panel(b).getByRole("button", { name: "Delete", exact: true }).waitFor();
  await startComposer(b).waitFor();
  const phoneWidth = (await startComposer(b).boundingBox()).width;
  assert(phoneWidth >= 390 - 32, `the phone's composer is ${phoneWidth}px wide`);
  assert.equal(await b.getByRole("button", { name: "Create PR" }).count(), 0);
  assert.equal(await b.locator('[data-slot="mobile-tab-bar"]').count(), 0);
  await shot(b, "failed-mobile");
  check(
    "A failed start says why in the transcript and nothing else is offered: the message is kept, nothing is left on disk, Retry and Delete, and the chat's composer",
    { reason: failing.error_message }
  );

  // ── 4. Retry in place, watched from a second device.
  gitLaunch("branch", "develop");
  await panel(a).getByRole("button", { name: "Retry", exact: true }).click();
  // Stages reach every client over the WebSocket: the phone follows the desktop's retry.
  await Promise.all([
    panel(a).getByText("Running setup…").waitFor(),
    panel(b).getByText("Running setup…").waitFor(),
  ]);
  await waiting.getByText("Add a dark mode toggle to the settings page").waitFor();
  // One message waits per workspace: a second is refused in words and stays in the box.
  const draft = "Then make it follow the system theme";
  await startComposer(a).locator("textarea").fill(draft);
  await startComposer(a).locator("textarea").press("Enter");
  await toast(a, "A message is already waiting for this workspace").waitFor();
  assert.equal(await startComposer(a).locator("textarea").inputValue(), draft);
  assert.equal(await waiting.count(), 1);
  await waiting.getByText("Add a dark mode toggle to the settings page").waitFor();
  assert.equal(await panel(a).getAttribute("data-state"), "starting");
  // The tools pane slides in as the retry starts: measure once the column stops moving.
  const startBox = await until("the start page's layout to settle", async () => {
    const before = await startComposer(a).boundingBox();
    await a.waitForTimeout(200);
    const after = await startComposer(a).boundingBox();
    return JSON.stringify(before) === JSON.stringify(after) ? after : null;
  });
  await watchBottom(a);
  await shot(a, "starting", 0);
  const retried = await until("the retried workspace to be ready", async () => {
    const row = await workspace(failing.id);
    return row.state === "ready" ? row : null;
  });
  assert.equal(retried.slug, failing.slug, "a retry keeps the workspace's name");
  assert(retried.current_session_id);
  assert.equal(
    execFileSync("git", ["branch", "--show-current"], {
      cwd: path.join(launch, ".deus", retried.slug),
    })
      .toString()
      .trim(),
    retried.git_branch
  );
  // The kept message is sent to the chat the retry opened.
  await until("the kept message to be sent", () =>
    sent.some(
      (frame) =>
        frame.includes('"sendMessage"') &&
        frame.includes("Add a dark mode toggle to the settings page")
    )
  );
  await until("the sent message to stop waiting", () =>
    a.evaluate((id) => !window.pendingFirstMessages.get(id), failing.id)
  );
  const handover = await readBottom(a);
  // What was typed on the start page is in the chat's composer, which sits where it sat.
  // (This backend refuses the send, so the kept message comes back ahead of it.)
  await until(
    "the chat's composer to hold the draft",
    async () =>
      (await chatComposer(a)
        .locator("textarea")
        .inputValue()
        .catch(() => "")) === `Add a dark mode toggle to the settings page\n\n${draft}`
  );
  const chatBox = await chatComposer(a).boundingBox();
  for (const [what, start, chat] of [
    ["x", startBox.x, chatBox.x],
    ["width", startBox.width, chatBox.width],
    ["bottom", startBox.y + startBox.height, chatBox.y + chatBox.height],
  ]) {
    assert(Math.abs(start - chat) <= 1, `the composer's ${what} moved: ${start} → ${chat}`);
  }
  // The chat it started with opens with how it started: one line, its steps folded under it.
  await startLine(a).waitFor();
  await startLine(a).getByRole("button").first().click();
  await startLine(a).getByText("Ran setup").waitFor();
  await shot(a, "started");
  await a.waitForTimeout(1000);
  assert.equal(sends("Add a dark mode toggle to the settings page"), 1, "sent once");
  assert.equal(
    await refusal(backend.write("retryWorkspaceInit", { workspaceId: failing.id })),
    "This workspace is not waiting for a retry."
  );
  assert.equal(
    await refusal(backend.write("deleteWorkspace", { workspaceId: failing.id })),
    "Only a workspace that failed to start can be deleted."
  );
  assert.equal((await workspace(failing.id)).state, "ready");
  check(
    "Retry starts the same workspace again, both clients follow it, the kept message is sent once, a second is refused and moves to the chat, and the chat opens with the start",
    { composer: { start: startBox, chat: chatBox }, handover }
  );

  // ── 5. The remote cannot be reached: the workspace still starts, and its chat says it may be behind.
  git("remote", "add", "origin", "http://127.0.0.1:9/project.git");
  const behind = await create();
  await until(
    "the workspace to be ready",
    async () => (await workspace(behind.id)).state === "ready"
  );
  assert.equal((await workspace(behind.id)).init_fetch_issue, "offline");
  await a.locator(`[data-workspace-id="${behind.id}"]`).click();
  // Off the row and out of focus, so its hover card is not in the picture.
  await a.mouse.move(1100, 600);
  await a.evaluate(() => document.activeElement?.blur());
  await startLine(a).getByText("1 warning").waitFor();
  await a.getByText(/Couldn't reach the remote repository.*It may be behind\./).waitFor();
  await shot(a, "behind");
  check(
    "An unreachable remote does not stop a start; the chat opens with a warning that it may be behind"
  );

  // ── 6. A remote that hangs: creating answers at once, the wait is shown.
  slowOrigin = net.createServer((socket) => setTimeout(() => socket.destroy(), 5000));
  await new Promise((resolve) => slowOrigin.listen(0, "127.0.0.1", resolve));
  git("remote", "set-url", "origin", `http://127.0.0.1:${slowOrigin.address().port}/project.git`);
  const slow = await create();
  assert(slow.ackMs < 1500, `creating must not wait for the fetch (took ${slow.ackMs}ms)`);
  await a.goto(url(slow.id));
  await attach(a);
  await panel(a).getByText("Getting the latest changes…").waitFor();
  assert.equal((await workspace(slow.id)).init_stage, "fetch");
  // Started with no message: one typed on its start page waits, and is sent when it is ready.
  const asked = "Explain how this project is laid out";
  await startComposer(a).locator("textarea").fill(asked);
  await startComposer(a).locator("textarea").press("Enter");
  await watchBottom(a);
  const askedWaiting = panel(a).locator('[data-slot="waiting-message"]');
  await askedWaiting.getByText(asked).waitFor();
  assert.equal(await startComposer(a).locator("textarea").inputValue(), "");
  await shot(a, "asked-while-starting", 0);
  await until(
    "the workspace to be ready",
    async () => (await workspace(slow.id)).state === "ready"
  );
  const askedHandover = await readBottom(a);
  await until("the message typed there to be sent", () => sends(asked));
  await a.waitForTimeout(1000);
  assert.equal(sends(asked), 1, "sent once");
  // On a phone, the Code tab picked while a start runs gives way to its failure.
  const doomedOnPhone = await create({ source_branch: "not-on-the-phone" });
  await b.goto(url(doomedOnPhone.id));
  await attach(b);
  await b.getByRole("tab", { name: "Code" }).click();
  await panel(b).getByRole("button", { name: "Retry", exact: true }).waitFor();
  await shot(b, "failed-mobile-from-code", 0);
  await backend.write("deleteWorkspace", { workspaceId: doomedOnPhone.id });
  check(
    "Creating a workspace returns before the fetch; the fetch is a visible stage; a message typed while it starts is sent once it is ready; a phone on the Code tab sees the failure",
    {
      ackMs: slow.ackMs,
      handover: askedHandover,
    }
  );

  // ── 7. Two workspaces started back to back: each gets its own message, once,
  // whichever is on screen, and a reload in the middle neither loses nor repeats one.
  const startFromHome = async (text) => {
    const before = (await allWorkspaces()).map((row) => row.id);
    await a.getByRole("button", { name: "New workspace in project", exact: true }).click();
    await composer(a).fill(text);
    await composer(a).press("Enter");
    await panel(a).locator('[data-slot="waiting-message"]').getByText(text).waitFor();
    return (await allWorkspaces()).find((row) => !before.includes(row.id));
  };
  const changelog = await startFromHome("Write the changelog");
  const license = await startFromHome("Add a license file");
  // A workspace that is still starting can be opened from the sidebar: its row says where it is.
  const startingRow = a.locator(`[data-workspace-id="${changelog.id}"]`);
  await startingRow.getByText("Updating…").waitFor();
  await startingRow.click();
  await panel(a)
    .locator('[data-slot="waiting-message"]')
    .getByText("Write the changelog")
    .waitFor();
  await panel(a).getByText("Getting the latest changes…").waitFor();
  await shot(a, "starting-row", 0);
  // The window reloads while both are starting, and reopens on neither.
  await a.reload();
  await attach(a);
  for (const row of [changelog, license]) {
    await until(
      "the workspace to be ready",
      async () => (await workspace(row.id)).state === "ready"
    );
  }
  await until(
    "both messages to be sent",
    () => sends("Write the changelog") && sends("Add a license file")
  );
  // This backend has no agent engine and refuses the send. It is not sent again
  // behind the user's back: it waits in that chat's composer, and a toast says so.
  await toast(a, "Your message is in that chat's composer.").first().waitFor();
  await shot(a, "refused");
  await a.locator(`[data-workspace-id="${license.id}"]`).click();
  await until(
    "the chat's composer to hold the refused message",
    async () =>
      (await main(a)
        .locator("textarea")
        .first()
        .inputValue()
        .catch(() => "")) === "Add a license file"
  );
  await a.waitForTimeout(1500);
  assert.equal(sends("Write the changelog"), 1, "sent once");
  assert.equal(sends("Add a license file"), 1, "sent once");
  for (const row of [changelog, license]) {
    assert(!(await a.evaluate((id) => window.pendingFirstMessages.get(id), row.id)));
  }
  check(
    "Two workspaces started back to back each get their own message once, across a reload; a starting one opens from the sidebar; a refused send waits in the composer"
  );
  git("remote", "remove", "origin");

  // ── 8. A failure nobody is looking at comes to them; Delete hands the message back to Home.
  // Home was last left on another project.
  await a.goto(url(home));
  await attach(a);
  await a.getByRole("button", { name: "New workspace in launch", exact: true }).click();
  await main(a).getByRole("button", { name: "launch", exact: true }).waitFor();
  await a.goto(url(home));
  await attach(a);
  const doomed = await create({ source_branch: "nope" });
  const notice = toast(a, "didn't start");
  await notice.waitFor();
  assert((await notice.innerText()).includes('The branch "nope" does not exist'));
  await shot(a, "toast");
  await notice.getByRole("button", { name: "View", exact: true }).click();
  await panel(a).getByText("Workspace didn't start").waitFor();
  await keep(a, doomed.id, "Rename the billing page");
  await panel(a).getByRole("button", { name: "Delete", exact: true }).click();
  const deleted = toast(a, "Workspace deleted");
  await deleted.waitFor();
  assert((await deleted.innerText()).includes("Your message is back on Home."));
  assert.equal(await refusal(workspace(doomed.id)), "Workspace not found");
  assert.equal(await a.locator(`[data-workspace-id="${doomed.id}"]`).count(), 0);
  // Not only in a toast that expires: the message is in Home's composer, to send again.
  await until(
    "Home's composer to hold the message",
    async () => (await composer(a).inputValue()) === "Rename the billing page"
  );
  // In the project it was typed for, not the one Home was last left on.
  await main(a).getByRole("button", { name: "project", exact: true }).waitFor({ timeout: 3000 });
  await shot(a, "deleted");
  check(
    "A failure elsewhere toasts; Delete removes it and hands its message back to Home, in its project"
  );

  // ── 9. A workspace that cannot be created: the message stays where it was typed.
  const vanishing = crypto.randomUUID();
  await mkdir(path.join(directory, "vanish"));
  db.prepare(
    "INSERT INTO repositories (id, name, root_path, git_default_branch, sort_order) VALUES (?, 'vanish', ?, 'main', 2)"
  ).run(vanishing, path.join(directory, "vanish"));
  await a.goto(url(home));
  await attach(a);
  await a.getByRole("button", { name: "New workspace in vanish", exact: true }).click();
  await composer(a).fill("Tidy the release notes");
  db.prepare("DELETE FROM repositories WHERE id = ?").run(vanishing);
  await composer(a).press("Enter");
  await toast(a, "Repository not found").waitFor();
  await a.getByText("What are we building?").waitFor();
  assert.equal(await composer(a).inputValue(), "Tidy the release notes");
  await shot(a, "not-created");
  check("A workspace that cannot be created says why and leaves the message in Home's composer");

  // ── 10. A waiting message whose chat another window spoke to first goes to that
  // chat's composer, unsent.
  const missed = "Pick up where the other window left off";
  await keep(a, home, missed);
  await until("the missed message to stop waiting", () =>
    a.evaluate((id) => !window.pendingFirstMessages.get(id), home)
  );
  await a.locator(`[data-workspace-id="${home}"]`).click();
  await until(
    "the chat's composer to hold the missed message",
    async () =>
      (await chatComposer(a)
        .locator("textarea")
        .inputValue()
        .catch(() => "")) === missed
  );
  assert.equal(sends(missed), 0, "a missed message is not sent");
  check("A waiting message whose chat was spoken to first goes to that chat's composer, unsent");

  // ── 11. A failed setup still opens the chat, with the script's own words in view.
  await writeFile(
    path.join(repo, ".deus/environment.json"),
    JSON.stringify({
      version: 1,
      setup:
        "echo starting; sleep 1; printf 'Checking tools\\n\\033[31mMissing <b>clang</b>\\033[0m\\n' >&2; exit 1",
    })
  );
  git("add", ".deus/environment.json");
  git("commit", "-qm", "Exercise a failing setup");
  const failedSetup = await create();
  await a.locator(`[data-workspace-id="${failedSetup.id}"]`).click();
  const warning = startLine(a).getByText(/The setup script failed,/);
  await warning.waitFor();
  assert.equal(
    await warning.textContent(),
    "The setup script failed, so this workspace started without it. Setup exited with code 1.\nChecking tools\nMissing <b>clang</b>"
  );
  await startLine(a).screenshot({ path: path.join(evidence, "setup-warning.png") });
  check("A failed setup opens the chat with the last two log lines visible as plain text");

  assert.deepEqual(errors, []);
  report.errors = errors;
  await writeFile(path.join(evidence, "results.json"), JSON.stringify(report, null, 2));
  console.log(
    `PASS: workspace start journey (${report.checks.length} checks); evidence in ${evidence}`
  );
} catch (error) {
  report.error = error.stack;
  report.errors = errors;
  await writeFile(path.join(evidence, "results.json"), JSON.stringify(report, null, 2));
  for (const [index, context] of (browser?.contexts() ?? []).entries()) {
    for (const page of context.pages())
      await page.screenshot({ path: path.join(evidence, `failure-${index}.png`) }).catch(() => {});
  }
  throw error;
} finally {
  await browser?.close();
  await vite?.close();
  slowOrigin?.close();
  backend?.close();
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
