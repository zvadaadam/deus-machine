// The location menu with several organizations, on the Mac lane: the real web app against
// the real backend, which holds one key per organization (what the desktop app hands it).
// Acme and Beta are set up on this computer; Gamma has no key here. The scripted platform
// (./platform.mjs) lists the account's organizations and each one's
// automations, mints GitHub App tokens for Acme and Beta (so nothing asks GitHub), and
// records which key each request carried. No sandbox, no model call.
// Run: bun run test:e2e:cloud   (or node --import tsx test/e2e/cloud/organizations.browser.mjs)
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { createServer } from "vite";
import { chromium } from "playwright";
import { SCHEMA_SQL } from "../../../shared/schema.ts";
import { LOOPBACK_WEB_ORIGINS } from "../../../shared/web-origins.ts";
import { pause, scriptedTurn, startPlatform, until } from "./platform.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const output = path.join(root, ".context/cloud-e2e/organizations-browser");
const shots = path.join(root, ".context/shots/org-menu");
await mkdir(output, { recursive: true });
await mkdir(shots, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const check = (name, details) => console.log(`PASS: ${name}`, details ?? "");

const BEARER = "bearer-orgs-browser";
/** An automation as the platform's dashboard lists it. */
const automation = (organization, id, description) => ({
  id,
  organization_id: organization,
  user_id: null,
  name: id,
  description,
  status: "active",
  spec: {
    triggers: [{ type: "cron", cron: "0 9 * * 1-5", timezone: "UTC" }],
    prompt: "Review the open pull requests.",
    environment: "repo-deus-smoke-orgs",
    model: "claude-opus-5",
    thinking_level: "high",
    session_policy: "fresh_session",
    overlap_policy: "skip",
  },
  external_identifier: null,
  deduplication_key: null,
  webhook_enabled: false,
  next_run_at: null,
  last_run_at: null,
  consecutive_failures: 0,
  paused_reason: null,
  paused_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
});
const ACME = {
  id: "org_acme",
  name: "Acme",
  key: "agnt_sk_acme",
  sessions: ["ses_a1", "ses_a2"],
  githubToken: "ghs_acme",
  automations: [automation("org_acme", "auto-acme", "Acme nightly review")],
};
const BETA = {
  id: "org_beta",
  name: "Beta",
  key: "agnt_sk_beta",
  sessions: ["ses_b1"],
  githubToken: "ghs_beta",
  automations: [automation("org_beta", "auto-beta", "Beta weekly review")],
};
// An organization of the account this computer holds no key for.
const GAMMA = { id: "org_gamma", name: "Gamma", sessions: [] };
const ORGS = [ACME, BETA, GAMMA];
const orgOf = (session) => ORGS.find((o) => o.sessions.includes(session))?.id ?? ACME.id;

const repository = crypto.randomUUID();
const local = { id: crypto.randomUUID(), title: "Local org smoke" };
const cloud = [
  { id: crypto.randomUUID(), title: "Acme first", provider: "ses_a1", org: ACME.id },
  { id: crypto.randomUUID(), title: "Acme second", provider: "ses_a2", org: ACME.id },
  { id: crypto.randomUUID(), title: "Beta first", provider: "ses_b1", org: BETA.id },
];
const [a1, a2, b1] = cloud;
const ALL_TITLES = [local.title, ...cloud.map((w) => w.title)];

// What the backend asks the platform for that this journey does not serve. Each is
// answered 404 and the backend carries on; a request not listed here fails the run.
const UNSERVED = new Set([
  "GET /models",
  // Settings → Environments in Beta: its saved setups and GitHub access.
  `GET /dashboard/orgs/${BETA.id}/environment-settings`,
  `GET /orgs/${BETA.id}/github/accessible-repos`,
  `GET /orgs/${BETA.id}/github/install-url`,
  ...cloud.flatMap((w) => [`GET /workspaces/wsp_${w.provider}`, `GET /sessions/${w.provider}`]),
]);
// The create in Beta goes as far as the platform's routes for it; their 404 fails it.
const CREATE_ROUTE = /^(GET|POST|PUT|PATCH) \/(environments|workspaces|sessions|secrets)/;

const platform = await startPlatform({
  bearer: BEARER,
  orgs: ORGS,
  snapshot: (id) => ({
    type: "session.snapshot",
    state: {
      sessionId: id,
      organizationId: orgOf(id),
      workspaceId: `wsp_${id}`,
      status: "ready",
      sandboxUrlTemplate: null,
      currentTurnId: null,
    },
    messages: [],
    events: [],
  }),
});

// ---- This computer: one repository, a local workspace and three cloud ones ----------
const repo = path.join(directory, "repository");
await mkdir(repo);
// Its own repository (never this worktree's origin), with an origin a sandbox could clone.
const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
git("init", "-b", "main");
git("remote", "add", "origin", "https://github.com/deus-smoke/orgs.git");
const db = new Database(path.join(directory, "deus.db"));
db.exec(SCHEMA_SQL);
db.pragma("journal_mode = WAL");
db.prepare(
  "INSERT INTO repositories (id, name, root_path, git_origin_url) VALUES (?, 'Orgs', ?, 'https://github.com/deus-smoke/orgs.git')"
).run(repository, repo);
db.prepare(
  "INSERT INTO workspaces (id, repository_id, slug, title, state, setup_status, git_branch, git_target_branch) VALUES (?, ?, 'local-orgs', ?, 'ready', 'completed', 'local-orgs', 'main')"
).run(local.id, repository, local.title);
for (const w of cloud) {
  const session = crypto.randomUUID();
  db.prepare(
    "INSERT INTO workspaces (id, repository_id, slug, title, state, setup_status, current_session_id, git_branch, git_target_branch, kind, provider_workspace_id, organization_id) VALUES (?, ?, ?, ?, 'ready', 'completed', ?, ?, 'main', 'cloud', ?, ?)"
  ).run(w.id, repository, w.provider, w.title, session, w.provider, `wsp_${w.provider}`, w.org);
  db.prepare(
    "INSERT INTO sessions (id, workspace_id, agent_harness, status, provider_session_id) VALUES (?, ?, 'claude-code', 'idle', ?)"
  ).run(session, w.id, w.provider);
}
await writeFile(
  path.join(directory, "preferences.json"),
  JSON.stringify({
    onboarding_completed: true,
    remote_access_enabled: false,
    theme: "dark",
  })
);

// The platform is the only cloud this backend may reach (Deus Cloud's GitHub mint
// included), and it has no key of its own: every key it holds is one the desktop handed it.
const env = { ...process.env };
for (const name of ["DEUS_CLOUD_URL", "DEUS_CLOUD_ENV", "AGNT_API_KEY", "DEUS_CLOUD_AGNT_API_KEY"])
  delete env[name];
const log = createWriteStream(path.join(directory, "backend.log"));
const child = spawn(process.execPath, ["--import", "tsx", "apps/backend/src/server.ts"], {
  cwd: root,
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...env,
    PORT: "0",
    DATABASE_PATH: path.join(directory, "deus.db"),
    // Never the login Keychain, and git never climbs out of the run into this checkout.
    DEUS_VAULT_NO_KEYCHAIN: "1",
    GIT_CEILING_DIRECTORIES: directory,
    // The web app this runner serves, at whatever port Vite takes.
    DEUS_WEB_ORIGINS: LOOPBACK_WEB_ORIGINS,
    TSX_TSCONFIG_PATH: path.join(root, "apps/backend/tsconfig.json"),
    AGNT_BASE_URL: platform.url,
    DEUS_GITHUB_API_URL: `${platform.url}/github`,
    DEUS_BUNDLED_BIN_DIR: path.join(root, "test/e2e/fixtures/github"),
    DEUS_CLOUD_AGNT_URL: platform.url,
    DEUS_CLOUD_URL: platform.url,
    // As the desktop starts it: the spawn token is the first line on its stdin.
    DEUS_STOP_ON_STDIN_END: "1",
  },
});
child.stdin.write("desktop-orgs-browser\n");
child.stdout.pipe(log);
child.stderr.pipe(log);
let vite, browser, page;
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
  const handCredentials = async (credentials) => {
    const handed = await fetch(`http://127.0.0.1:${port}/api/settings/cloud/credentials`, {
      method: "POST",
      headers: { authorization: "Bearer desktop-orgs-browser", "content-type": "application/json" },
      body: JSON.stringify(credentials),
    });
    assert.equal(handed.status, 200, await handed.text());
  };
  // What the desktop app hands the backend: the session and a key per organization set up.
  await handCredentials({
    deusCloudSessionToken: BEARER,
    orgKeys: { [ACME.id]: ACME.key, [BETA.id]: BETA.key },
  });

  vite = await createServer({
    configFile: path.join(root, "apps/web/vite.config.ts"),
    cacheDir: path.join(directory, "vite-cache"),
    logLevel: "error",
    define: { "import.meta.env.VITE_BACKEND_PORT": JSON.stringify(String(port)) },
    // No hot reload: a source edit during a run must not reload a page mid-journey.
    server: { host: "127.0.0.1", port: 0, hmr: false, fs: { allow: [root] } },
  });
  await vite.listen();
  const base = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await context.newPage();
  page.setDefaultTimeout(60_000);
  page.on("pageerror", (error) => errors.push(error.message));

  const sidebar = page.locator('[data-slot="sidebar"]').first();
  const header = sidebar.getByRole("button", { name: /switch where workspaces run/ });
  const menu = page.getByRole("menu");
  const row = (name) => menu.getByRole("menuitem", { name: new RegExp(name) });
  const settled = () =>
    menu.evaluate((e) => Promise.all(e.getAnimations({ subtree: true }).map((a) => a.finished)));
  const headerLabel = async () => (await header.innerText()).trim().split("\n").at(-1);
  const listed = async () => {
    const shown = [];
    for (const title of ALL_TITLES) {
      if ((await sidebar.getByText(title, { exact: true }).count()) > 0) shown.push(title);
    }
    return shown;
  };
  /** The window shows `name` in the header and lists exactly `titles`. */
  const showing = async (name, titles) => {
    await until(`the header to read ${name}`, async () => (await headerLabel()) === name);
    await until(
      `the sidebar to list ${titles.join(", ")}`,
      async () => JSON.stringify(await listed()) === JSON.stringify(titles)
    );
  };
  // The app's modules, passed to the page as values: they resolve in the browser, under Vite.
  const STORE_MODULE = "/src/features/workspace/store/workspaceStore.ts";
  const ROUTER_MODULE = "/src/app/router.ts";
  const selected = () =>
    page.evaluate(async (store) => {
      const { useWorkspaceStore } = await import(store);
      return useWorkspaceStore.getState().selectedWorkspaceId;
    }, STORE_MODULE);
  const openMenu = async () => {
    await header.click();
    await menu.waitFor();
    await row(GAMMA.name).waitFor();
    await settled();
  };
  const closeMenu = async () => {
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
  };
  const menuRows = () =>
    menu
      .getByRole("menuitem")
      .evaluateAll((es) =>
        es.map((e) => [
          e.innerText.trim().replace(/\s+/g, " "),
          e.getAttribute("aria-current"),
          e.getAttribute("aria-disabled"),
        ])
      );

  // 1. The menu: this computer, then each organization by name, ⌃2 and ⌃3; Gamma not set up.
  await page.goto(`${base}s/local/`, { timeout: 120_000 });
  await header.waitFor();
  await until("the computer's name", async () => !(await headerLabel()).includes("This computer"));
  const computer = await headerLabel();
  await showing(computer, [local.title]);
  await openMenu();
  const rows = await menuRows();
  // Each row: its glyph (the profile's initials, an organization's initial), name and hint.
  assert.ok(rows[0][0].endsWith(computer), rows[0][0]);
  assert.deepEqual(
    rows.slice(1, 4).map(([text]) => text),
    ["A Acme ⌃2", "B Beta ⌃3", "G Gamma Not set up"],
    JSON.stringify(rows)
  );
  assert.equal(rows[0][1], "true", "the check is on this computer");
  assert.equal(rows[3][2], "true", "Gamma's row is disabled");
  await page.screenshot({ path: path.join(shots, "two-organizations-one-not-set-up.png") });
  check("the menu lists this computer and each organization; one not set up reads so", {
    rows: rows.map(([text]) => text),
  });

  // Choosing a row, and ⌃2 / ⌃3: the trigger, the list and the check follow.
  await row(ACME.name).click();
  await menu.waitFor({ state: "detached" });
  await showing(ACME.name, [a1.title, a2.title]);
  await page.keyboard.press("Control+3");
  await showing(BETA.name, [b1.title]);
  await openMenu();
  assert.equal(await row(BETA.name).getAttribute("aria-current"), "true");
  assert.equal(await row(ACME.name).getAttribute("aria-current"), null);
  await page.screenshot({ path: path.join(shots, "in-second-organization.png") });
  await closeMenu();
  await page.keyboard.press("Control+2");
  await showing(ACME.name, [a1.title, a2.title]);
  await page.keyboard.press("Control+1");
  await showing(computer, [local.title]);
  check("choosing a row, Ctrl+2 and Ctrl+3 switch; the header, the list and the check follow");

  // 2. Each organization returns to the workspace last selected there.
  await page.keyboard.press("Control+2");
  await showing(ACME.name, [a1.title, a2.title]);
  await sidebar.getByText(a1.title, { exact: true }).click();
  await until("Acme's workspace selected", async () => (await selected()) === a1.id);
  await page.keyboard.press("Control+3");
  await showing(BETA.name, [b1.title]);
  assert.equal(await selected(), null, "nothing was selected in Beta yet: Home");
  await sidebar.getByText(b1.title, { exact: true }).click();
  await until("Beta's workspace selected", async () => (await selected()) === b1.id);
  await page.keyboard.press("Control+2");
  await until("Acme's workspace restored", async () => (await selected()) === a1.id);
  await page.keyboard.press("Control+3");
  await until("Beta's workspace restored", async () => (await selected()) === b1.id);
  await showing(BETA.name, [b1.title]);
  check("switching back returns to the workspace last selected in each organization");

  // 3. Opening a workspace of the other organization moves the window there.
  await page.evaluate(
    async ([router, id]) => {
      const { webRouter } = await import(router);
      await webRouter.navigate({
        to: "/s/$serverId/w/$workspaceId",
        params: { serverId: "local", workspaceId: id },
      });
    },
    [ROUTER_MODULE, a2.id]
  );
  await showing(ACME.name, [a1.title, a2.title]);
  await sidebar.locator('[aria-current="page"]').getByText(a2.title).waitFor();
  check("opening Acme's workspace from Beta moves the window to Acme");

  // 4. A reply streaming in Acme keeps arriving while the window is on Beta.
  await sidebar.getByText(a1.title, { exact: true }).click();
  await until("Acme's first workspace selected", async () => (await selected()) === a1.id);
  await until("its session attached", () => platform.live(a1.provider));
  const prompt = "Say hello from Acme";
  await page.locator('[contenteditable="true"], textarea').first().click();
  await page.keyboard.type(prompt);
  await page.keyboard.press("Enter");
  const sent = await until("the message.send command", () =>
    platform.commands(a1.provider).find((c) => c.type === "message.send")
  );
  const turn = scriptedTurn(platform, a1.provider, sent);
  turn.start();
  await page.getByText("Hello from the scripted").waitFor();
  const socket = platform.live(a1.provider);
  await page.keyboard.press("Control+3");
  await showing(BETA.name, [b1.title]);
  await until("Beta's workspace restored", async () => (await selected()) === b1.id);
  turn.finishReply();
  turn.end();
  await pause(500);
  assert.equal(socket.open, true, "Acme's session socket stayed open while on Beta");
  assert.equal(platform.socketsFor(a1.provider).length, 1, "and was not replaced");
  await page.keyboard.press("Control+2");
  await until("Acme's workspace restored", async () => (await selected()) === a1.id);
  await page.getByText(turn.reply).waitFor();
  assert.equal(await page.getByText(prompt, { exact: true }).count(), 1);
  check("a reply streaming in Acme kept arriving while the window was on Beta: all of it is there");

  // 5. Gamma, with no key here: Not set up, disabled; its shortcut does nothing.
  await page.keyboard.press("Control+4");
  await pause(500);
  await showing(ACME.name, [a1.title, a2.title]);
  await openMenu();
  const gamma = row(GAMMA.name);
  await gamma.getByText("Not set up").waitFor();
  assert.equal(await gamma.getAttribute("aria-disabled"), "true");
  await closeMenu();
  check("Gamma reads Not set up and is disabled in a browser; Ctrl+4 does nothing");

  // 6. The composer's Cloud control, from this computer: "Cloud" and off. Its menu lists
  // the organizations as the header's does; choosing Beta turns it on there and names
  // Beta, and the sidebar stays on this computer. Creating then reaches the platform with
  // Beta's key only, and the window follows the new workspace to Beta.
  const composerShots = path.join(root, ".context/shots/org-composer");
  await mkdir(composerShots, { recursive: true });
  await page.keyboard.press("Control+1");
  await showing(computer, [local.title]);
  await sidebar.getByText("New workspace", { exact: true }).click();
  const toggle = page.getByRole("switch", { name: /^Run on a cloud computer/ }).first();
  const chooser = page.getByRole("button", { name: "Choose the cloud organization" }).first();
  const control = chooser.locator("xpath=..");
  await chooser.waitFor();
  await page.locator("textarea").first().waitFor();
  await pause(800);
  assert.equal((await chooser.innerText()).trim(), "Cloud", "off, it names no organization");
  assert.equal(await toggle.getAttribute("aria-checked"), "false");
  assert.equal(await toggle.getAttribute("aria-label"), "Run on a cloud computer");
  await control.screenshot({ path: path.join(composerShots, "off.png") });
  // Measured before the menu opens: an open menu hides the rest of the page from role queries.
  const controlBox = await control.boundingBox();
  await chooser.click();
  await menu.waitFor();
  await settled();
  const composerRows = await menuRows();
  assert.deepEqual(
    composerRows.map(([text]) => text),
    ["A Acme", "B Beta", "G Gamma Not set up"],
    JSON.stringify(composerRows)
  );
  assert.ok(
    composerRows.every(([, current]) => current === null),
    "no check while the cloud is off"
  );
  assert.equal(composerRows[2][2], "true", "Gamma is disabled");
  const shotAround = async (found, file) => {
    const boxes = found.filter(Boolean);
    const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - 16);
    const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - 16);
    const width = Math.max(...boxes.map((b) => b.x + b.width)) + 16 - x;
    const height = Math.max(...boxes.map((b) => b.y + b.height)) + 16 - y;
    await page.screenshot({ path: path.join(composerShots, file), clip: { x, y, width, height } });
  };
  await shotAround([controlBox, await menu.boundingBox()], "menu-open.png");
  await row(BETA.name).click();
  await menu.waitFor({ state: "detached" });
  await until(
    "the composer in Beta's cloud",
    async () => (await toggle.getAttribute("aria-checked")) === "true"
  );
  assert.equal((await chooser.innerText()).trim(), BETA.name);
  assert.equal(await toggle.getAttribute("aria-label"), `Run on a cloud computer in ${BETA.name}`);
  await showing(computer, [local.title]);
  const sidebarSaved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("sidebar-storage"))
  );
  assert.equal(sidebarSaved.state.location, "local", "the sidebar did not move");
  await pause(300);
  await control.screenshot({ path: path.join(composerShots, "on.png") });
  await chooser.click();
  await menu.waitFor();
  assert.equal(await row(BETA.name).getAttribute("aria-current"), "true", "the check is on Beta");
  await closeMenu();
  check("from this computer the control reads Cloud, off; choosing Beta turns it on there", {
    rows: composerRows.map(([text]) => text),
  });
  const before = platform.authorized.length;
  await page.locator("textarea").first().click();
  await page.keyboard.type("Start in Beta");
  await page.keyboard.press("Enter");
  const created = await until("the new cloud row", () =>
    db
      .prepare(
        "SELECT id, slug, organization_id FROM workspaces WHERE kind = 'cloud' AND id NOT IN (?, ?, ?)"
      )
      .get(...cloud.map((w) => w.id))
  );
  assert.equal(created.organization_id, BETA.id, "the row is Beta's");
  await until("the platform asked to create it", () =>
    platform.authorized.slice(before).some((r) => CREATE_ROUTE.test(r.route))
  );
  await pause(500);
  const asked = platform.authorized.slice(before);
  // The create's own requests (the model catalog, read with the default key, is not one).
  const keys = [...new Set(asked.filter((r) => CREATE_ROUTE.test(r.route)).map((r) => r.key))];
  assert.deepEqual(keys, [BETA.key], JSON.stringify(asked));
  // The GitHub App token is Beta's. The backend reuses one answer per organization and
  // repository for a short time, so the composer's access check may have asked it
  // already; the create asks no other organization's.
  assert.ok(
    platform.authorized.some((r) => r.route === `POST /orgs/${BETA.id}/github/installation-token`),
    "the GitHub App token was Beta's"
  );
  assert.ok(
    !asked.some(
      (r) =>
        r.route.endsWith("/github/installation-token") &&
        r.route !== `POST /orgs/${BETA.id}/github/installation-token`
    ),
    "no other organization's token"
  );
  await until("the new row listed in Beta", async () => (await selected()) === created.id);
  await until("the window followed it to Beta", async () => (await headerLabel()) === BETA.name);
  await sidebar.locator('[aria-current="page"]').waitFor();
  const newRowText = (await sidebar.locator('[aria-current="page"]').innerText()).trim();
  await page.keyboard.press("Control+2");
  await showing(ACME.name, [a1.title, a2.title]);
  assert.equal(
    await sidebar.getByText(created.slug, { exact: false }).count(),
    0,
    "the new row is not listed in Acme"
  );
  check(
    "creating in Beta from this computer reached the platform with Beta's key; the row is Beta's only",
    {
      keys,
      routes: [...new Set(asked.map((r) => r.route))],
      row: newRowText,
    }
  );

  // 7. Settings in Beta: Environments has Beta selected, not the default organization.
  // A browser on the Mac lane has no desktop session to read, so the page is told the one
  // the desktop app would answer (signed in, as the backend is).
  await page.keyboard.press("Control+3");
  await showing(BETA.name, [b1.title]);
  const UI_MODULE = "/src/shared/stores/uiStore.ts";
  const RUNTIME_MODULE = "/src/platform/ws/query-protocol-client.ts";
  await page.evaluate(
    async ([runtime, url]) => {
      const { getRuntimeClient } = await import(runtime);
      getRuntimeClient().queryClient.setQueryData(["deus-cloud", "session"], {
        signedIn: true,
        accountId: "acc_smoke",
        expiresAt: null,
        tokenType: "Bearer",
        cloudUrl: url,
        hasPlatformKey: true,
      });
    },
    [RUNTIME_MODULE, platform.url]
  );
  await page.evaluate(async (ui) => {
    const { useUIStore } = await import(ui);
    useUIStore.getState().setActiveSettingsSection("environment");
    useUIStore.getState().openSettings();
  }, UI_MODULE);
  const organizationSelect = page.getByRole("combobox", { name: "Organization", exact: true });
  await until(
    "Environments to show Beta",
    async () =>
      (await organizationSelect.count()) > 0 &&
      (await organizationSelect.innerText()).trim() === BETA.name
  );
  await page.screenshot({ path: path.join(shots, "settings-environments-in-beta.png") });
  await page.evaluate(async (ui) => {
    const { useUIStore } = await import(ui);
    useUIStore.getState().closeSettings();
  }, UI_MODULE);
  await showing(BETA.name, [b1.title]);
  check("in Beta, Settings → Environments has Beta selected");

  // 8. Automations in Beta: only Beta's are listed, the page names Beta, and opening it
  // asks the platform for Beta's list (the start-up mirror read both organizations).
  const listedAutomations = (id) =>
    platform.requests.filter((r) => r === `GET /dashboard/orgs/${id}/automations`).length;
  assert.ok(listedAutomations(ACME.id) > 0, "the start-up mirror read Acme's automations");
  assert.ok(listedAutomations(BETA.id) > 0, "and Beta's");
  const betaReadsBefore = listedAutomations(BETA.id);
  await page.evaluate(async (ui) => {
    const { useUIStore } = await import(ui);
    useUIStore.getState().openAutomations();
  }, UI_MODULE);
  const main = page.locator("main, [data-slot='sidebar-inset']").last();
  await main.getByText("Beta weekly review", { exact: true }).waitFor();
  await main.getByText(`In ${BETA.name}`, { exact: true }).waitFor();
  assert.equal(await main.getByText("Acme nightly review", { exact: true }).count(), 0);
  await until(
    "the page to refresh Beta's list",
    () => listedAutomations(BETA.id) > betaReadsBefore
  );
  await page.screenshot({ path: path.join(shots, "automations-in-beta.png") });
  // Switching returns to Acme's last workspace, which leaves the page: open it again there.
  await page.keyboard.press("Control+2");
  await showing(ACME.name, [a1.title, a2.title]);
  await page.evaluate(async (ui) => {
    const { useUIStore } = await import(ui);
    useUIStore.getState().openAutomations();
  }, UI_MODULE);
  await main.getByText("Acme nightly review", { exact: true }).waitFor();
  await main.getByText(`In ${ACME.name}`, { exact: true }).waitFor();
  assert.equal(await main.getByText("Beta weekly review", { exact: true }).count(), 0);
  await page.evaluate(async (ui) => {
    const { useUIStore } = await import(ui);
    useUIStore.getState().closeAutomations();
  }, UI_MODULE);
  check("the automations page lists only the window's organization's, and names it", {
    betaReads: listedAutomations(BETA.id),
  });

  // 9. A reload keeps the organization.
  await page.keyboard.press("Control+3");
  await showing(BETA.name, [b1.title]);
  await page.goto(`${base}s/local/`);
  await header.waitFor();
  await page.reload();
  await header.waitFor();
  await until("Beta after the reload", async () => (await headerLabel()) === BETA.name);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("sidebar-storage")));
  assert.equal(saved.state.location, "cloud");
  assert.equal(saved.state.cloudOrganizationId, BETA.id);
  check("a reload keeps the organization", { saved: saved.state.cloudOrganizationId });

  // 10. Signed out, pushed to the open window without a reload: the one cloud row.
  await handCredentials({ deusCloudSessionToken: null, orgKeys: null });
  await until("this computer, pushed", async () => (await headerLabel()) === computer);
  await header.click();
  await menu.waitFor();
  await row("Deus Cloud").getByText("Not signed in").waitFor();
  assert.equal(await menu.getByText(ACME.name).count(), 0, "no organization is named");
  await settled();
  await page.screenshot({ path: path.join(shots, "signed-out-single-cloud-row.png") });
  await closeMenu();
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("sidebar-storage")));
  assert.equal(stored.state.cloudOrganizationId, BETA.id, "the choice is kept");
  check("signing out reaches the open window at once: one cloud row, Not signed in");

  assert.deepEqual(errors, [], "no page error");
  const unexpected = [...new Set(platform.unserved)].filter(
    (route) => !UNSERVED.has(route) && !CREATE_ROUTE.test(route)
  );
  assert.deepEqual(unexpected, [], "the backend asked the platform only for what it serves");
  check("no page error, and the platform was asked for nothing unexpected");
  console.log(`\nAll checks passed. Artifacts: ${directory}`);
} catch (error) {
  console.error(`FAILED: ${error.stack ?? error}`);
  console.error(
    "UI",
    (
      await page
        ?.locator("body")
        .innerText()
        .catch(() => "")
    )?.slice(0, 1500)
  );
  console.error("unserved", [...new Set(platform.unserved)]);
  await page?.screenshot({ path: path.join(directory, "failure.png") }).catch(() => {});
  console.error("backend log:", path.join(directory, "backend.log"), "page errors:", errors);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await vite?.close();
  child.kill("SIGTERM");
  platform.close();
  db.close();
}
