// Where a window's workspaces run: the sidebar header's location switcher, in the
// real web app against the real backend. An isolated database holds one local and
// one cloud workspace in the same repository; the cloud is the scripted platform
// (./cloud/platform.mjs), so the backend is signed in to Deus Cloud and opening the
// cloud workspace attaches its session. Then the backend is signed out, as the desktop
// app signs it out, and in again. No sandbox, no model call.
// Run: node --import tsx test/e2e/workspace-location.browser.mjs
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { createServer } from "vite";
import { chromium } from "playwright";
import { SCHEMA_SQL } from "../../shared/schema.ts";
import { LOOPBACK_WEB_ORIGINS } from "../../shared/web-origins.ts";
import { pause, startPlatform, until } from "./cloud/platform.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const screenshots = path.join(root, ".context/workspace-location");
await mkdir(screenshots, { recursive: true });
const directory = await mkdtemp(path.join(screenshots, "run-"));
const check = (name, details) => console.log(`PASS: ${name}`, details ?? "");

const repository = crypto.randomUUID();
const local = crypto.randomUUID();
const localSession = crypto.randomUUID();
const cloud = crypto.randomUUID();
const cloudSession = crypto.randomUUID();
const PROVIDER = "ses_location_smoke";
const PROVIDER_WORKSPACE = "wsp_location_smoke";
const LOCAL_TITLE = "Local location smoke";
const CLOUD_TITLE = "Cloud location smoke";
const ORG = "org_smoke";
// The header names the cloud by its organization.
const ORG_NAME = "Smoke Labs";

// ---- The scripted platform: the cloud workspace's session -----------------------
const platform = await startPlatform({
  bearer: "bearer-smoke",
  sessions: [PROVIDER],
  org: ORG,
  orgName: ORG_NAME,
  snapshot: (id) => ({
    type: "session.snapshot",
    state: {
      sessionId: id,
      organizationId: ORG,
      workspaceId: PROVIDER_WORKSPACE,
      status: "ready",
      sandboxUrlTemplate: "https://{{port}}-smoke.sandbox.test",
      currentTurnId: null,
    },
    messages: [],
    events: [],
  }),
});

// ---- This computer: one repository, a local worktree and a cloud workspace ------
const repo = path.join(directory, "repository");
await mkdir(repo);
const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
git("init", "-b", "main");
await writeFile(path.join(repo, "README.md"), "# location smoke\n");
git("add", ".");
git("-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", "commit", "-m", "init");
git("worktree", "add", "-b", "local-smoke", path.join(repo, ".deus", "local-smoke"));
const db = new Database(path.join(directory, "deus.db"));
db.exec(SCHEMA_SQL);
db.pragma("journal_mode = WAL");
db.prepare("INSERT INTO repositories (id, name, root_path) VALUES (?, 'Smoke', ?)").run(
  repository,
  repo
);
db.prepare(
  "INSERT INTO workspaces (id, repository_id, slug, title, state, setup_status, current_session_id, git_branch, git_target_branch) VALUES (?, ?, 'local-smoke', ?, 'ready', 'completed', ?, 'local-smoke', 'main')"
).run(local, repository, LOCAL_TITLE, localSession);
db.prepare(
  "INSERT INTO sessions (id, workspace_id, agent_harness, status) VALUES (?, ?, 'claude-code', 'idle')"
).run(localSession, local);
db.prepare(
  "INSERT INTO workspaces (id, repository_id, slug, title, state, setup_status, current_session_id, git_branch, git_target_branch, kind, provider_workspace_id) VALUES (?, ?, 'cloud-smoke', ?, 'ready', 'completed', ?, 'cloud-smoke', 'main', 'cloud', ?)"
).run(cloud, repository, CLOUD_TITLE, cloudSession, PROVIDER_WORKSPACE);
db.prepare(
  "INSERT INTO sessions (id, workspace_id, agent_harness, status, provider_session_id) VALUES (?, ?, 'claude-code', 'idle', ?)"
).run(cloudSession, cloud, PROVIDER);
await writeFile(
  path.join(directory, "preferences.json"),
  JSON.stringify({
    onboarding_completed: true,
    analytics_enabled: false,
    remote_access_enabled: false,
    theme: "dark",
  })
);

const env = { ...process.env };
delete env.DEUS_CLOUD_URL;
delete env.DEUS_CLOUD_ENV;
// The platform key arrives the way the desktop app hands it over, so it can be taken away.
delete env.AGNT_API_KEY;
delete env.DEUS_CLOUD_AGNT_API_KEY;
const log = createWriteStream(path.join(directory, "backend.log"));
const child = spawn(process.execPath, ["--import", "tsx", "apps/backend/src/server.ts"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...env,
    PORT: "0",
    DATABASE_PATH: path.join(directory, "deus.db"),
    // The web app this runner serves, at whatever port Vite takes.
    DEUS_WEB_ORIGINS: LOOPBACK_WEB_ORIGINS,
    TSX_TSCONFIG_PATH: path.join(root, "apps/backend/tsconfig.json"),
    AGNT_BASE_URL: platform.url,
    DEUS_CLOUD_AGNT_URL: platform.url,
    AUTH_TOKEN: "desktop-smoke-token",
  },
});
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
  // What the desktop app hands the backend after sign-in (this computer's platform key and
  // the account's session), and after sign-out (nothing).
  const handCredentials = async (credentials) => {
    const handed = await fetch(`http://127.0.0.1:${port}/api/settings/cloud/credentials`, {
      method: "POST",
      headers: { authorization: "Bearer desktop-smoke-token", "content-type": "application/json" },
      body: JSON.stringify(credentials),
    });
    assert.equal(handed.status, 200, await handed.text());
  };
  const SIGNED_IN = { apiKey: "agnt_sk_smoke", deusCloudSessionToken: "bearer-smoke" };
  await handCredentials(SIGNED_IN);

  vite = await createServer({
    configFile: path.join(root, "apps/web/vite.config.ts"),
    cacheDir: path.join(directory, "vite-cache"),
    logLevel: "error",
    define: { "import.meta.env.VITE_BACKEND_PORT": JSON.stringify(String(port)) },
    server: { host: "127.0.0.1", port: 0, fs: { allow: [root] } },
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
  const lists = async (title) => (await sidebar.getByText(title, { exact: true }).count()) > 0;
  const headerLabel = async () => (await header.innerText()).trim().split("\n").at(-1);
  const showing = async (location) => {
    const [shown, hidden] =
      location === "cloud" ? [CLOUD_TITLE, LOCAL_TITLE] : [LOCAL_TITLE, CLOUD_TITLE];
    await sidebar.getByText(shown, { exact: true }).waitFor();
    await sidebar.getByText(hidden, { exact: true }).waitFor({ state: "detached" });
    assert.equal(await lists(hidden), false, `${hidden} is not listed in ${location}`);
    // In the cloud the header reads the organization's name once its list arrives.
    if (location === "cloud") {
      await until("the organization's name in the header", async () => {
        return (await headerLabel()) === ORG_NAME;
      });
    }
    const label = await headerLabel();
    if (location === "local") assert.ok(![ORG_NAME, "Deus Cloud"].includes(label), label);
    return label;
  };
  const storedLocation = () =>
    page.evaluate(() => JSON.parse(localStorage.getItem("sidebar-storage")).state.location);
  const selected = () =>
    page.evaluate(async () => {
      const { useWorkspaceStore } = await import("/src/features/workspace/store/workspaceStore.ts");
      return useWorkspaceStore.getState().selectedWorkspaceId;
    });

  // 1. The default view: this computer's workspaces only.
  await page.goto(`${base}s/local/`);
  await header.waitFor();
  // The computer's name arrives with the backend's answer; "This computer" until then.
  await until(
    "the computer's name",
    async () => !(await header.innerText()).includes("This computer")
  );
  const computer = await showing("local");
  check("the default view lists the local workspace and not the cloud one", { header: computer });

  // 2. The menu: both locations, the check on the current one, the cloud by its name.
  await header.click();
  await menu.waitFor();
  await row(ORG_NAME).waitFor();
  const items = await menu
    .getByRole("menuitem")
    .evaluateAll((es) =>
      es.map((e) => [e.innerText.trim().split("\n"), e.getAttribute("aria-current")])
    );
  const current = items.filter(([, mark]) => mark === "true").map(([lines]) => lines);
  assert.equal(current.length, 1, "one row is checked");
  assert.ok(current[0].includes(computer), "the check is on this computer");
  assert.ok(
    items.some(([lines]) => lines.includes(ORG_NAME)),
    "the cloud row names the org"
  );
  assert.ok(items.some(([lines]) => lines.includes("Your computers")));
  assert.ok(items.some(([lines]) => lines.includes("Settings")));
  assert.equal(await menu.getByText("Not signed in").count(), 0, "signed in to Deus Cloud");
  await settled();
  await page.screenshot({ path: path.join(screenshots, "menu-local.png") });
  check("the header menu shows both locations with the check on the current one", {
    rows: items.map(([lines]) => lines.join(" ")),
  });

  // 3. Choosing the cloud.
  await row(ORG_NAME).click();
  await showing("cloud");
  await header.click();
  await menu.waitFor();
  assert.equal(await row(ORG_NAME).getAttribute("aria-current"), "true");
  await settled();
  await page.screenshot({ path: path.join(screenshots, "menu-cloud.png") });
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  check(
    "choosing the cloud lists the cloud workspace, not the local one, and the header and the row name its organization",
    { header: ORG_NAME }
  );

  // 4. The shortcuts.
  await page.keyboard.press("Control+1");
  await showing("local");
  await page.keyboard.press("Control+2");
  await showing("cloud");
  await page.keyboard.press("Control+1");
  await showing("local");
  check("Ctrl+1 and Ctrl+2 switch");

  // 5. Select the local workspace, then open the cloud one by URL (the router's own
  //    navigation, so this session's memory stays).
  await sidebar.getByText(LOCAL_TITLE, { exact: true }).click();
  await until("the local workspace selected", async () => (await selected()) === local);
  await page.evaluate(async (id) => {
    const { webRouter } = await import("/src/app/router.ts");
    await webRouter.navigate({
      to: "/s/$serverId/w/$workspaceId",
      params: { serverId: "local", workspaceId: id },
    });
  }, cloud);
  await showing("cloud");
  assert.equal(await selected(), cloud);
  await sidebar.locator('[aria-current="page"]').getByText(CLOUD_TITLE).waitFor();
  await until("the cloud session attached", () => platform.socketsFor(PROVIDER).length > 0);
  check("selecting a cloud workspace by URL lands with the location on cloud", {
    url: new URL(page.url()).pathname,
  });

  // 6. Switching back restores the local workspace; switching again, the cloud one.
  await page.keyboard.press("Control+1");
  await showing("local");
  await until("the local workspace restored", async () => (await selected()) === local);
  await sidebar.locator('[aria-current="page"]').getByText(LOCAL_TITLE).waitFor();
  await page.keyboard.press("Control+2");
  await until("the cloud workspace restored", async () => (await selected()) === cloud);
  check("switching back restores the workspace last selected in each location");

  // 7. The choice survives a reload (at the index, so no URL selection pulls it back).
  await page.goto(`${base}s/local/`);
  await header.waitFor();
  await showing("cloud");
  assert.equal(await selected(), null);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("sidebar-storage")));
  assert.equal(saved.state.location, "cloud");
  await page.reload();
  await header.waitFor();
  await showing("cloud");
  check("the choice survives a reload", { saved: saved.state.location });

  // 8. New workspaces default to the window's location: the Home composer's toggle.
  //    Signed in, it starts in the cloud once the repository's access verdict is in.
  // By label, not role: the open mobile sheet hides the page from the accessibility tree.
  const toggle = page.locator('[aria-label="Run on a cloud computer"]').first();
  await until(
    "the composer in the cloud",
    async () => (await toggle.getAttribute("aria-checked")) === "true"
  );
  check("the Home composer starts in the window's location (cloud, signed in)");

  // 9. Mobile: the same menu inside the sheet.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Expand sidebar" }).first().click();
  const mobileHeader = page
    .locator('[data-mobile="true"]')
    .getByRole("button", { name: /switch where workspaces run/ });
  await mobileHeader.click();
  await menu.waitFor();
  await row(ORG_NAME).waitFor();
  await settled();
  await page.screenshot({ path: path.join(screenshots, "menu-mobile.png") });
  await row(computer).click();
  await page.locator('[data-mobile="true"]').getByText(LOCAL_TITLE, { exact: true }).waitFor();
  check("the menu works in the mobile sheet at 390x844");
  await until(
    "the composer back to local",
    async () => (await toggle.getAttribute("aria-checked")) === "false"
  );
  check("the Home composer follows the window back to local");

  // 10. Signed out: a cloud this computer cannot reach is not where a window sits. The
  //     choice stays the cloud; the window shows this computer. This browser cannot sign
  //     the computer in (only its desktop app can), so the cloud row cannot be chosen.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}s/local/`);
  await header.waitFor();
  await page.keyboard.press("Control+2");
  await showing("cloud");
  await handCredentials({ apiKey: null, deusCloudSessionToken: null });
  await page.reload();
  await header.waitFor();
  await showing("local");
  await until("the computer's name", async () => (await headerLabel()) === computer);
  assert.equal(await storedLocation(), "cloud", "the stored choice is kept");
  await header.click();
  await menu.waitFor();
  const cloudRow = row("Deus Cloud");
  await cloudRow.getByText("Not signed in").waitFor();
  assert.equal(await cloudRow.getAttribute("aria-disabled"), "true", "the cloud row is disabled");
  assert.equal(await cloudRow.getAttribute("aria-current"), null, "the cloud row is not checked");
  assert.equal(await row(computer).getAttribute("aria-current"), "true");
  assert.equal(await menu.getByText(ORG_NAME).count(), 0, "no organization is named");
  await settled();
  await page.screenshot({ path: path.join(screenshots, "menu-signed-out.png") });
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  // Ctrl+2 does what the row does: here, nothing.
  await page.keyboard.press("Control+2");
  await pause(500);
  await showing("local");
  assert.equal(await storedLocation(), "cloud");
  assert.equal(await toggle.getAttribute("aria-checked"), "false", "the composer is local");
  check(
    "signed out, a window stored in the cloud opens on this computer; the cloud row reads Not signed in, disabled, and Ctrl+2 does nothing",
    { header: computer }
  );

  // 11. Signed in again, the window returns to the cloud by itself.
  await handCredentials(SIGNED_IN);
  await page.reload();
  await header.waitFor();
  await showing("cloud");
  check("signed in again, a reload shows the cloud it was left in");

  assert.deepEqual(errors, [], "no page error");
  check("no page error");
  console.log(JSON.stringify({ directory, screenshots }));
} catch (error) {
  console.error(
    "UI",
    await page
      ?.locator("body")
      .innerText()
      .catch(() => "")
  );
  await page?.screenshot({ path: path.join(directory, "failure.png") }).catch(() => {});
  console.error("backend log:", path.join(directory, "backend.log"), "page errors:", errors);
  throw error;
} finally {
  await browser?.close();
  await vite?.close();
  child.kill("SIGTERM");
  platform.close();
}
