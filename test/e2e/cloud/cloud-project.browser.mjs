// A project that is not on this computer, on the Mac lane: the real web app against the
// real backend, with two organizations set up (Acme, Beta). Only the platform is
// scripted (./platform.mjs): it lists each organization's reachable GitHub repositories,
// mints Acme's GitHub App token, and serves a scripted GitHub API (a repository's default
// branch and its branches, paged), which DEUS_GITHUB_API_URL points the backend at. No
// clone, no sandbox, no model call, nothing reaches the real GitHub.
// Run: bun run test:e2e:cloud   (or node --import tsx test/e2e/cloud/cloud-project.browser.mjs)
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
import { pause, startPlatform, until } from "./platform.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const output = path.join(root, ".context/cloud-e2e/cloud-project");
const shots = path.join(root, ".context/shots/cloud-project");
await mkdir(output, { recursive: true });
await mkdir(shots, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const check = (name, details) => console.log(`PASS: ${name}`, details ?? "");

const BEARER = "bearer-cloud-project";
const ACME = {
  id: "org_acme",
  name: "Acme",
  key: "agnt_sk_acme",
  sessions: [],
  githubToken: "ghs_acme",
  accessibleRepos: ["acme/rocket", "acme/local", "acme/docs"],
};
// Beta's GitHub access reaches nothing yet.
const BETA = {
  id: "org_beta",
  name: "Beta",
  key: "agnt_sk_beta",
  sessions: [],
  accessibleRepos: [],
};
// The scripted GitHub: rocket is private (Acme's token only), its default branch is not
// `main`, and it has more branches than one page holds.
const ROCKET_BRANCHES = [
  ...Array.from({ length: 70 }, (_, i) => `topic-${String(i).padStart(2, "0")}`),
  "trunk",
  "feature-a",
  ...Array.from({ length: 50 }, (_, i) => `later-${String(i).padStart(2, "0")}`),
];
const platform = await startPlatform({
  bearer: BEARER,
  orgs: [ACME, BETA],
  github: {
    "acme/rocket": { defaultBranch: "trunk", branches: ROCKET_BRANCHES, token: ACME.githubToken },
  },
  snapshot: (id) => ({
    type: "session.snapshot",
    state: {
      sessionId: id,
      organizationId: ACME.id,
      workspaceId: `wsp_${id}`,
      status: "ready",
      sandboxUrlTemplate: null,
      currentTurnId: null,
    },
    messages: [],
    events: [],
  }),
});

// What the backend asks the platform for that this journey does not serve; each is
// answered 404 and the backend carries on. A request not listed here fails the run.
const UNSERVED = new Set([
  "GET /models",
  // The automations mirror at startup: neither organization has any served.
  `GET /dashboard/orgs/${ACME.id}/automations`,
  `GET /dashboard/orgs/${BETA.id}/automations`,
  // Home's composer in Beta with rocket chosen asks for Beta's token: it has none.
  `POST /orgs/${BETA.id}/github/installation-token`,
]);
// The create goes as far as the platform's routes for it; their 404 ends it.
const CREATE_ROUTE = /^(GET|POST|PUT|PATCH) \/(environments|workspaces|sessions|secrets)/;

// ---- This computer: one project with a folder (its own repository, git init'ed here) ----
const localRepoId = crypto.randomUUID();
const local = { id: crypto.randomUUID(), title: "Local project smoke" };
const repo = path.join(directory, "local");
await mkdir(repo);
const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
git("init", "-b", "main");
git("remote", "add", "origin", "https://github.com/acme/local.git");
const db = new Database(path.join(directory, "deus.db"));
db.exec(SCHEMA_SQL);
db.pragma("journal_mode = WAL");
db.prepare(
  "INSERT INTO repositories (id, name, root_path, git_origin_url) VALUES (?, 'local', ?, 'https://github.com/acme/local.git')"
).run(localRepoId, repo);
db.prepare(
  "INSERT INTO workspaces (id, repository_id, slug, title, state, setup_status, git_branch, git_target_branch) VALUES (?, ?, 'local-smoke', ?, 'ready', 'completed', 'local-smoke', 'main')"
).run(local.id, localRepoId, local.title);
// A project on this computer with no GitHub remote, first in the list: it can run here
// only, so the composer in the cloud must not offer or preselect it.
const plainRepo = path.join(directory, "plain");
await mkdir(plainRepo);
execFileSync("git", ["init", "-b", "main"], { cwd: plainRepo, stdio: "pipe" });
db.prepare(
  "INSERT INTO repositories (id, name, root_path, sort_order) VALUES (?, 'aaa-plain', ?, -1)"
).run(crypto.randomUUID(), plainRepo);
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
    DEUS_CLOUD_AGNT_URL: platform.url,
    DEUS_CLOUD_URL: platform.url,
    DEUS_GITHUB_API_URL: `${platform.url}/github`,
    // As the desktop starts it: the spawn token is the first line on its stdin.
    DEUS_STOP_ON_STDIN_END: "1",
  },
});
child.stdin.write("desktop-cloud-project\n");
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
  const handed = await fetch(`http://127.0.0.1:${port}/api/settings/cloud/credentials`, {
    method: "POST",
    headers: { authorization: "Bearer desktop-cloud-project", "content-type": "application/json" },
    body: JSON.stringify({
      deusCloudSessionToken: BEARER,
      orgKeys: { [ACME.id]: ACME.key, [BETA.id]: BETA.key },
    }),
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
  const base = vite.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await context.newPage();
  page.setDefaultTimeout(60_000);
  page.on("pageerror", (error) => errors.push(error.message));

  const sidebar = page.locator('[data-slot="sidebar"]').first();
  const header = sidebar.getByRole("button", { name: /switch where workspaces run/ });
  const headerLabel = async () => (await header.innerText()).trim().split("\n").at(-1);
  const projectRow = (name) => sidebar.getByText(name, { exact: true });
  const addProject = sidebar.getByRole("button", { name: "Add project" });
  const popover = page.locator('[data-slot="popover-content"]');
  const dialog = page.getByRole("dialog");
  /** In a cloud organization "Add project" is its one action: the dialog, no menu. */
  const openAddDialog = async () => {
    await addProject.click();
    await dialog.getByText("Add repository", { exact: true }).waitFor();
    assert.equal(await popover.count(), 0, "no menu of one");
  };
  /** The titles the "Add project" popover offers. */
  const addActions = async () => {
    await addProject.click();
    await popover.waitFor();
    await pause(300);
    const titles = await popover
      .locator("button p.font-medium")
      .evaluateAll((es) => es.map((e) => e.textContent.trim()));
    return titles;
  };

  await page.goto(`${base}s/local/`, { timeout: 120_000 });
  await header.waitFor();
  await until("the computer's name", async () => !(await headerLabel()).includes("This computer"));
  const computer = await headerLabel();

  // 6 (first, so it is "unchanged"): on this computer, "Add project" is the local actions.
  // A browser has no native folder picker, so "Open local project" is the desktop's third.
  const localActions = await addActions();
  assert.deepEqual(localActions, ["Start new project", "Clone from GitHub"]);
  await page.keyboard.press("Escape");
  await popover.waitFor({ state: "detached" });
  check("on this computer, Add project offers the local actions, unchanged", { localActions });

  // 1. In Acme, "Add project" is one action, and it opens the dialog: no destination,
  // Acme's repositories, the one that is already a project marked.
  await page.keyboard.press("Control+2");
  await until("the window in Acme", async () => (await headerLabel()) === ACME.name);
  // The composer here points at the cloud: the project with no remote is neither
  // preselected nor offered (on this computer it is the first project).
  const cloudSwitch = page.getByRole("switch", { name: /^Run on a cloud computer/ }).first();
  await until(
    "the composer in the cloud",
    async () => (await cloudSwitch.getAttribute("aria-checked")) === "true"
  );
  // The composer's project picker: the button with the chosen project's green dot.
  const composerProject = page
    .locator("button", { has: page.locator("span.bg-accent-green") })
    .first();
  await until("the composer's project", async () => (await composerProject.innerText()).trim());
  assert.equal((await composerProject.innerText()).trim(), "local", "the first that runs here");
  await composerProject.click();
  await page.getByText("Add from GitHub").first().waitFor();
  assert.equal(await page.getByText("aaa-plain", { exact: true }).count(), 0, "not offered");
  await page.keyboard.press("Escape");
  await page.locator("textarea").first().click();
  check("in the cloud the composer does not offer or preselect a project with no GitHub remote");
  await openAddDialog();
  const cloudActions = ["Add from GitHub"];
  await dialog.getByText("acme/rocket", { exact: true }).waitFor();
  const dialogText = await dialog.innerText();
  assert.ok(!/destination/i.test(dialogText), "no destination field");
  assert.ok(!/clone a git repository/i.test(dialogText), dialogText);
  assert.ok(dialogText.includes("Acme's GitHub access"), "it names whose access it is");
  const rows = await dialog
    .locator("button:has(span.truncate)")
    .evaluateAll((es) => es.map((e) => e.innerText.trim().replace(/\s+/g, " ")));
  assert.deepEqual(rows, ["acme/rocket", "acme/local Added", "acme/docs"], JSON.stringify(rows));
  assert.equal(
    await dialog.getByText("Manage GitHub access").count(),
    1,
    "any client with a computer behind it can manage GitHub access"
  );
  await pause(300);
  await dialog.screenshot({ path: path.join(shots, "list.png") });
  const accessible = platform.authorized.filter(
    (r) => r.route === `GET /orgs/${ACME.id}/github/accessible-repos`
  );
  assert.ok(accessible.length > 0 && accessible.every((r) => r.key === BEARER), "with the session");
  await dialog.getByRole("button", { name: "Use a public repository" }).click();
  const publicField = dialog.getByRole("textbox", { name: "Public repository address" });
  const publicButton = dialog.getByRole("button", { name: /^(Add|Open)$/ });
  await publicField.fill("not a repo");
  assert.ok(await publicButton.isDisabled(), "Add is off for what is not a GitHub repository");
  await publicField.fill("acme/local");
  await dialog.getByText("acme/local is already a project.").waitFor();
  assert.equal((await publicButton.innerText()).trim(), "Open");
  await publicField.fill("https://github.com/acme/public");
  assert.equal((await publicButton.innerText()).trim(), "Add");
  assert.ok(await publicButton.isEnabled(), "Add is on for a GitHub address");
  check("the public field takes only a GitHub repository, and says Open for one already a project");
  await pause(200);
  await dialog.screenshot({ path: path.join(shots, "public-url.png") });
  // The search narrows the list.
  await dialog.getByRole("textbox", { name: "Search repositories" }).fill("rock");
  await until(
    "the search to narrow the list",
    async () => (await dialog.getByText("acme/docs", { exact: true }).count()) === 0
  );
  check("in Acme, Add project opens Add repository: no destination, Acme's repositories", {
    cloudActions,
    rows,
  });

  // 2. Choosing rocket adds a project with no folder, and Home has it chosen.
  await dialog.getByText("acme/rocket", { exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  const added = await until("the new project", () =>
    db.prepare("SELECT * FROM repositories WHERE git_origin_url LIKE '%acme/rocket'").get()
  );
  assert.equal(added.root_path, null, "no folder");
  assert.equal(added.git_origin_url, "https://github.com/acme/rocket");
  assert.equal(added.name, "rocket");
  assert.equal(added.git_default_branch, "trunk", "the default branch GitHub names");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM repositories").get().n, 3);
  await projectRow("rocket").waitFor();
  await page.keyboard.press("Control+1");
  await until("this computer", async () => (await headerLabel()) === computer);
  await projectRow("local").waitFor();
  await pause(300);
  assert.equal(await projectRow("rocket").count(), 0, "not listed on this computer");
  await page.keyboard.press("Control+2");
  await until("Acme again", async () => (await headerLabel()) === ACME.name);
  await projectRow("rocket").waitFor();
  // Choosing the same repository again adds nothing.
  await openAddDialog();
  await dialog
    .getByText("acme/rocket Added")
    .waitFor()
    .catch(() => {});
  await until("rocket marked as added", async () =>
    (await dialog.locator("button", { hasText: "acme/rocket" }).innerText()).includes("Added")
  );
  await dialog.getByText("acme/rocket", { exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM repositories").get().n, 3, "one project");
  // The composer has it chosen; its picker shows owner/name where a path would be.
  const textarea = page.locator("textarea").first();
  await textarea.waitFor();
  const repoTrigger = page.getByRole("button", { name: /^rocket$/ }).first();
  await repoTrigger.waitFor();
  await repoTrigger.click();
  await page.getByText("acme/rocket", { exact: true }).first().waitFor();
  await page.keyboard.press("Escape");
  await textarea.click();
  check("choosing it adds a project with no folder: listed in Acme, not on this computer", {
    project: { root_path: added.root_path, origin: added.git_origin_url },
  });

  // 3. The branch picker lists GitHub's branches, the default first, with Acme's token.
  const branchButton = page.getByRole("button", { name: "trunk" }).first();
  await branchButton.waitFor();
  await branchButton.click();
  const branchList = popover.last();
  await branchList.getByText("feature-a").waitFor();
  const branches = await branchList
    .locator("button")
    .evaluateAll((es) => es.map((e) => e.innerText.trim()));
  // No clone, so no remote-tracking refs: plain names.
  assert.ok(!branches.some((name) => name.startsWith("origin/")), JSON.stringify(branches));
  assert.equal(branches[0], "trunk", "the default first");
  assert.equal(branches.length, ROCKET_BRANCHES.length, "every page");
  assert.equal(new Set(branches).size, branches.length, "each once");
  const pages = platform.githubRequests.filter((r) => r.route.endsWith("/branches"));
  assert.ok(pages.length >= 2, "paged");
  assert.ok(
    platform.githubRequests.every((r) => r.key === ACME.githubToken),
    JSON.stringify(platform.githubRequests)
  );
  await branchList.getByRole("button", { name: /feature-a$/ }).click();
  await page.getByRole("button", { name: "feature-a" }).first().waitFor();
  check("the branch picker lists the scripted GitHub branches, default first", {
    first: branches.slice(0, 3),
    count: branches.length,
    pages: pages.length,
  });

  // 4. The Cloud switch is on and cannot be turned off.
  const toggle = page.getByRole("switch", { name: /^Run on a cloud computer/ }).first();
  assert.equal(await toggle.getAttribute("aria-checked"), "true");
  assert.ok(await toggle.isDisabled(), "the switch is disabled");
  await toggle.click({ force: true });
  await pause(300);
  assert.equal(await toggle.getAttribute("aria-checked"), "true", "still on");
  await toggle.hover({ force: true });
  await page.getByText("rocket is not on this Mac").first().waitFor();
  check("the Cloud switch is on, cannot be turned off, and says rocket is not on this Mac");

  // 5. Creating reaches the platform with rocket's address, the branch chosen and Acme's key.
  const before = platform.authorized.length;
  await textarea.click();
  await page.keyboard.type("Start rocket in the cloud");
  await page.keyboard.press("Enter");
  const created = await until("the cloud row", () =>
    db
      .prepare(
        "SELECT id, kind, organization_id, git_branch FROM workspaces WHERE repository_id = ?"
      )
      .get(added.id)
  );
  assert.equal(created.kind, "cloud");
  assert.equal(created.organization_id, ACME.id);
  const createWorkspace = await until("the platform asked to create the workspace", () =>
    platform.authorized.slice(before).find((r) => r.route === "POST /workspaces")
  );
  assert.equal(createWorkspace.key, ACME.key, "with Acme's key");
  const body = JSON.parse(createWorkspace.body);
  const sent = JSON.stringify(body);
  assert.ok(sent.includes('"https://github.com/acme/rocket"'), sent);
  assert.equal(body.checkout?.from, "feature-a", sent);
  const createKeys = [
    ...new Set(
      platform.authorized
        .slice(before)
        .filter((r) => CREATE_ROUTE.test(r.route))
        .map((r) => r.key)
    ),
  ];
  assert.deepEqual(createKeys, [ACME.key]);
  check("creating reached the platform with rocket's URL, feature-a and Acme's key", {
    checkout: body.checkout,
    keys: createKeys,
  });

  // The pull-request target is the branch the workspace started from, even while the
  // project's stored default is stale (added while GitHub would not say: `main`).
  const ready = { id: crypto.randomUUID(), session: crypto.randomUUID() };
  db.prepare("UPDATE repositories SET git_default_branch = 'main' WHERE id = ?").run(added.id);
  db.prepare(
    "INSERT INTO workspaces (id, repository_id, slug, title, state, setup_status, current_session_id, git_branch, git_target_branch, kind, organization_id) VALUES (?, ?, 'rocket-ready', 'Rocket ready', 'ready', 'completed', ?, 'rocket-ready', 'trunk', 'cloud', ?)"
  ).run(ready.id, added.id, ready.session, ACME.id);
  db.prepare(
    "INSERT INTO sessions (id, workspace_id, agent_harness, status) VALUES (?, ?, 'claude-code', 'idle')"
  ).run(ready.session, ready.id);
  await page.goto(`${base}s/local/w/${ready.id}`);
  const createPr = page.getByRole("button", { name: "Create PR" });
  await createPr.waitFor();
  const target = createPr.locator("xpath=following-sibling::button[1]");
  await until("the PR target", async () => (await target.innerText()).trim() === "trunk");
  await page.screenshot({ path: path.join(shots, "pr-target.png") });
  check("the PR target is the branch the workspace started from (trunk), not a stale main");

  // The empty state: Beta's GitHub access reaches nothing.
  await page.keyboard.press("Control+3");
  await until("Beta", async () => (await headerLabel()) === BETA.name);
  await openAddDialog();
  await dialog.getByText("Beta's GitHub access reaches no repositories yet.").waitFor();
  await dialog.getByRole("button", { name: "Connect GitHub", exact: true }).waitFor();
  await pause(300);
  await dialog.screenshot({ path: path.join(shots, "empty.png") });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  check("Beta's dialog says its GitHub access reaches nothing, and how to connect it");

  // Nothing reached the real GitHub: every GitHub call went to the scripted one.
  const backendLog = path.join(directory, "backend.log");
  assert.deepEqual(errors, [], "no page error");
  const unexpected = [...new Set(platform.unserved)].filter(
    (route) => !UNSERVED.has(route) && !CREATE_ROUTE.test(route)
  );
  assert.deepEqual(unexpected, [], "the backend asked the platform only for what it serves");
  check("no page error, and the platform was asked for nothing unexpected", { backendLog });
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
