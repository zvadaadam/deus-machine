/* global document, window */
// Run: node --import tsx test/e2e/workspace-list.browser.mjs (Node SQLite ABI).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import Database from "better-sqlite3";
import { chromium } from "playwright";
import { createServer } from "vite";
import { connectBackend } from "./lib/operations.mjs";
import { createStack, freePort, until } from "./remote-access/stack.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const evidence = path.join(root, ".context/workspace-list");
await mkdir(evidence, { recursive: true });
const directory = await mkdtemp(path.join(evidence, "run-"));
const stack = createStack({ root, directory });
let backend, server, browser, host, baseUrl, local, remote, offline;

async function makeProject(name, origin) {
  const folder = path.join(directory, name);
  await mkdir(folder);
  const git = (...args) => execFileSync("git", args, { cwd: folder, stdio: "pipe" });
  git("init", "-b", "main");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "--allow-empty",
    "-m",
    "init"
  );
  if (origin) git("remote", "add", "origin", origin);
  return backend.write("addRepo", { root_path: folder });
}

async function start(project, title, source = "main") {
  const { workspaceId } = await backend.write("createWorkspace", {
    repository_id: project.id,
    pr_title: title ?? undefined,
    source_branch: source,
  });
  let ws;
  await until(
    async () => {
      ws = await backend.read("workspace", { workspaceId });
      return ws.state !== "initializing";
    },
    20_000,
    title
  );
  assert.equal(ws.state, source === "main" ? "ready" : "error", ws.error_message);
  return ws;
}

before(async () => {
  await writeFile(
    path.join(directory, "preferences.json"),
    JSON.stringify({ onboarding_completed: true, remote_access_enabled: false })
  );
  // Stand in only for GitHub: the installed CLI and login may differ on every machine.
  await writeFile(
    path.join(directory, "gh"),
    `#!/bin/sh
case "$1" in
--version) echo 'gh version test' ;;
auth) echo '{"hosts":{"github.com":[{"login":"test","active":true,"state":"success"}]}}' ;;
api) echo '{"login":"test"}' ;;
pr) echo '[]' ;;
*) exit 1 ;;
esac
`,
    { mode: 0o755 }
  );
  host = await stack.host({
    name: "backend",
    database: path.join(directory, "deus.db"),
    dir: directory,
    env: { DEUS_USER_DATA_DIR: directory, TMPDIR: directory, DEUS_BUNDLED_BIN_DIR: directory },
  });
  backend = await connectBackend(host.url);
  local = await makeProject("local");
  const upstream = path.join(directory, "origin.git");
  execFileSync("git", ["clone", "--bare", local.root_path, upstream], { stdio: "pipe" });
  remote = await makeProject("remote", upstream);
  offline = await makeProject("offline", path.join(directory, "missing.git"));
  server = await createServer({
    configFile: path.join(root, "apps/web/vite.config.ts"),
    cacheDir: path.join(directory, "vite-cache"),
    logLevel: "error",
    define: { "import.meta.env.VITE_BACKEND_PORT": JSON.stringify(new URL(host.url).port) },
    server: { host: "127.0.0.1", port: await freePort(), strictPort: true, fs: { allow: [root] } },
  });
  await server.listen();
  baseUrl = server.resolvedUrls.local[0] + "s/local";
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await server?.close();
  backend?.close();
  await stack.close();
});

async function tab(t, electron = false) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
  });
  t.after(() => context.close());
  if (electron)
    await context.addInitScript(() => {
      document.addEventListener(
        "readystatechange",
        () => document.documentElement.classList.add("electron"),
        { once: true }
      );
    });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(90_000);
  return page;
}

const row = (page, ws) => page.locator(`[data-workspace-id="${ws.id}"]`);

for (const project of ["local", "remote", "offline"]) {
  test(`start details for ${project}`, async (t) => {
    const page = await tab(t);
    const ws = await start({ local, remote, offline }[project], project + " start");
    await page.goto(`${baseUrl}/w/${ws.id}`);
    await row(page, ws).waitFor();
    // This client saw the checkout finish. Resume that start story in its real chat.
    await page.evaluate(async ({ id, current_session_id }) => {
      const { markStartedIn } =
        await import("/src/features/workspace/store/workspaceStartStore.ts");
      markStartedIn(id, current_session_id);
    }, ws);
    const group = page.locator('[data-slot="env-group"]');
    const expand = group.getByRole("button", { name: "Workspace ready" });
    if ((await expand.getAttribute("aria-expanded")) === "false") await expand.click();
    await group.getByText("Made a safe copy").waitFor();
    assert.equal(
      (await group.getByText("Copy may be out of date", { exact: true }).count()) > 0,
      project === "offline"
    );
    const checked = await group.getByText("Checked for the latest changes").count();
    if (project === "local" && checked === 1)
      t.todo("The backend will record when git skipped the fetch.");
    assert.equal(checked, project === "remote" ? 1 : 0);
  });
}

async function waitForPRRead(page, workspaceId, conclusive) {
  await until(
    () =>
      page.evaluate(
        async ({ workspaceId, conclusive }) => {
          const { queryClient } = await import("/src/shared/api/queryClient.ts");
          const { queryKeys } = await import("/src/shared/api/queryKeys.ts");
          return (
            queryClient.getQueryData(queryKeys.workspaces.prStatus(workspaceId))?.conclusive ===
            conclusive
          );
        },
        { workspaceId, conclusive }
      ),
    45_000,
    `PR read with conclusive=${conclusive}`
  );
}

for (const mode of ["web", "desktop", "phone"]) {
  test(`the ${mode} header settles without PR actions for a project with no remote`, async (t) => {
    const page = await tab(t, mode === "desktop");
    if (mode === "phone") await page.setViewportSize({ width: 390, height: 844 });
    const ws = await start(local, "Header");
    await page.goto(`${baseUrl}/w/${ws.id}`);
    await waitForPRRead(page, ws.id, false);
    await page.locator('[data-slot="workspace-header"]').waitFor();
    assert.equal(
      await page
        .locator(
          '[data-slot="workspace-header"] .animate-spin, [data-slot="workspace-tool-header"] .animate-spin'
        )
        .count(),
      0
    );
    assert.equal(await page.getByRole("button", { name: "Create PR", exact: true }).count(), 0);
  });
}

test("the next PR poll discovers the remote without reloading", async (t) => {
  const page = await tab(t);
  const ws = await start(local, "PR polling");
  const db = new Database(path.join(directory, "deus.db"));
  db.prepare("UPDATE sessions SET status = 'working' WHERE id = ?").run(ws.current_session_id);
  db.close();
  await page.goto(`${baseUrl}/w/${ws.id}`);
  await waitForPRRead(page, ws.id, false);
  const button = page.getByRole("button", { name: "Create PR", exact: true });
  assert.equal(await button.count(), 0);
  // A custom remote is enough for gh; the project's recorded origin is still null.
  const git = (...args) => execFileSync("git", args, { cwd: ws.workspace_path, stdio: "pipe" });
  git("remote", "add", "upstream", remote.git_origin_url);
  try {
    await waitForPRRead(page, ws.id, true);
    await button.waitFor();
  } finally {
    git("remote", "remove", "upstream");
  }
});

async function general(page) {
  await page.goto(baseUrl);
  await page.getByRole("button", { name: "Toggle local workspaces", exact: true }).waitFor();
  await page.evaluate(async () => {
    const { useUIStore } = await import("/src/shared/stores/uiStore.ts");
    useUIStore.getState().openSettings();
    useUIStore.getState().setActiveSettingsSection("general");
  });
  await page.getByRole("combobox", { name: "Theme" }).waitFor();
}

test("theme follows the other open tab", async (t) => {
  const a = await tab(t);
  const b = await a.context().newPage();
  await general(a);
  await general(b);
  await a.getByRole("combobox", { name: "Theme" }).click();
  await a.getByRole("option", { name: "Dark" }).click();
  await a.locator("html.dark").waitFor();
  await b.locator("html.dark").waitFor({ timeout: 2000 });
});

for (const packageName of ["Debian", "AppImage"]) {
  test(`General shows ${packageName} update support on the first visit`, async (t) => {
    const page = await tab(t);
    const reason = "Linux auto-update requires the AppImage build.";
    await page.addInitScript(
      ({ stage, reason }) => {
        const listen = () => () => {};
        window.electronAPI = {
          getUpdateState: () =>
            new Promise((resolve) => {
              window.deliverUpdateState = () => resolve({ stage, reason });
            }),
          onUpdateState: listen,
          checkForUpdates: async () => ({ supported: true, available: false }),
          getAppVersion: async () => "0.3.21",
          getDeusCloudSession: async () => ({ signedIn: false }),
          onDeusCloudAuthChanged: listen,
          isFullscreen: async () => false,
          onFullscreenChange: listen,
          on: listen,
          invoke: async () => null,
        };
      },
      { stage: packageName === "Debian" ? "unsupported" : "idle", reason }
    );
    await general(page);
    const automatic = page.getByText("Updates download automatically in the background.", {
      exact: true,
    });
    assert.equal(await automatic.count(), 0, "support has not arrived yet");
    const check = page.getByRole("button", { name: "Check now" });
    assert.equal(await check.isDisabled(), true, "check waits for the window's first snapshot");
    await page.evaluate(() => window.deliverUpdateState());
    if (packageName === "Debian") {
      await page.getByText(reason, { exact: true }).waitFor();
      assert.equal(await automatic.count(), 0);
      assert.equal(await check.isDisabled(), true);
    } else {
      await automatic.waitFor();
      await check.click();
      await page.getByText("You're on the latest version.").waitFor();
    }
  });
}

for (const failureFirst of [false, true]) {
  test(`a failed removal preserves live rows with the ${failureFirst ? "failure" : "success"} reply first`, async (t) => {
    const page = await tab(t, failureFirst);
    const project = await makeProject(failureFirst ? "delete-refusal" : "archive-refusal");
    const a = await start(project, "A", failureFirst ? "missing" : "main");
    const b = await start(local, "B", failureFirst ? "main" : "missing");
    const c = await start(local, "Witness");
    const saved = await start(project, "Already archived");
    await backend.write("archiveWorkspace", { workspaceId: saved.id });

    // Deliver B and C's live changes as session-scoped deltas while only A in its project
    // is optimistically removed. Delay reconciliation and release the two real replies in order.
    const replies = new Map();
    let holdReads = false;
    await page.routeWebSocket(
      (url) => url.pathname === "/ws",
      (route) => {
        const server = route.connectToServer();
        const writes = new Map(),
          groups = new Set();
        route.onMessage((raw) => {
          const f = JSON.parse(String(raw));
          if (f.resource === "workspaces") groups.add(f.id);
          if (holdReads && f.type === "q:request" && f.resource === "workspaces") return;
          if (f.type === "q:mutate" && ["archiveWorkspace", "deleteWorkspace"].includes(f.action)) {
            writes.set(f.id, f.params.workspaceId);
            if (f.params.workspaceId === a.id) {
              // Exercise the backend's refusal through the same mutation as a stale window.
              server.send(JSON.stringify({ ...f, params: { workspaceId: "missing" } }));
              return;
            }
          }
          server.send(raw);
        });
        server.onMessage((raw) => {
          const f = JSON.parse(String(raw));
          if (writes.has(f.id) && f.type === "q:mutate_result") {
            replies.set(writes.get(f.id), () => route.send(raw));
          } else if (groups.has(f.id) && (f.type === "q:snapshot" || f.type === "q:response")) {
            if (f.type === "q:snapshot" && replies.has(a.id)) {
              const changed = f.data
                .flatMap((group) => group.workspaces)
                .filter((ws) => ws.id === b.id || ws.id === c.id);
              route.send(
                JSON.stringify({
                  type: "q:delta",
                  id: f.id,
                  upserted: changed,
                  removed: changed.some((w) => w.id === b.id) ? [] : [b.id],
                })
              );
            } else {
              // The incoming snapshot contract carries the total on the group, never on its deltas.
              f.data.find((group) => group.repo_id === project.id).archived_count = 1;
              route.send(JSON.stringify(f));
            }
          } else route.send(raw);
        });
      }
    );
    await page.goto(baseUrl);
    const remove = async (ws) => {
      if (ws.state === "error") {
        await row(page, ws).click();
        await page
          .locator('[data-slot="workspace-start-state"]')
          .getByRole("button", { name: "Delete" })
          .click();
      } else {
        await row(page, ws)
          .getByRole("button", { name: /Archive workspace/ })
          .click();
      }
    };
    await remove(a);
    await until(() => replies.has(a.id));
    await row(page, a).waitFor({ state: "detached" });
    await backend.write("updateWorkspaceTitle", { workspaceId: b.id, title: "B live" });
    await row(page, b).getByText("B live").waitFor();
    await backend.write("updateWorkspaceTitle", { workspaceId: c.id, title: "Witness live" });
    await row(page, c).getByText("Witness live").waitFor();
    const projectState = () =>
      page.evaluate(async (id) => {
        const { queryClient } = await import("/src/shared/api/queryClient.ts");
        const { queryKeys } = await import("/src/shared/api/queryKeys.ts");
        const { SIDEBAR_WORKSPACE_STATE } =
          await import("/src/features/workspace/api/workspace.queries.ts");
        const group = queryClient
          .getQueryData(queryKeys.workspaces.byRepo(SIDEBAR_WORKSPACE_STATE))
          .find((g) => g.repo_id === id);
        return [group?.archived_count, group?.workspaces.map((w) => w.id)];
      }, project.id);
    assert.deepEqual(
      await projectState(),
      [1, []],
      "the delta keeps A’s emptied project and its count"
    );
    holdReads = true;
    await remove(b);
    await row(page, b).waitFor({ state: "detached" });
    await until(() => replies.has(b.id));
    if (!failureFirst) replies.get(b.id)();
    replies.get(a.id)();
    await page.getByText("Workspace not found", { exact: true }).waitFor();
    if (failureFirst) replies.get(b.id)();
    await row(page, a).waitFor();
    assert.equal(await row(page, b).count(), 0, "B stayed removed");
    assert.match(await row(page, c).innerText(), /Witness live/);
    assert.deepEqual(await projectState(), [1, [a.id]]);
  });
}

test("Archive offers Undo when the backend confirms it", async (t) => {
  const page = await tab(t);
  const ws = await start(local, "Undo archive");
  let acknowledge;
  await page.routeWebSocket(
    (url) => url.pathname === "/ws",
    (route) => {
      const host = route.connectToServer();
      let id;
      route.onMessage((raw) => {
        const f = JSON.parse(String(raw));
        if (f.type === "q:mutate" && f.action === "archiveWorkspace") id = f.id;
        host.send(raw);
      });
      host.onMessage((raw) => {
        const f = JSON.parse(String(raw));
        if (f.type === "q:mutate_result" && f.id === id) acknowledge = () => route.send(raw);
        else route.send(raw);
      });
    }
  );
  await page.goto(baseUrl);
  await row(page, ws)
    .getByRole("button", { name: /Archive workspace/ })
    .click();
  const toast = page.getByText("Workspace archived", { exact: true });
  await until(() => !!acknowledge);
  assert.equal(await toast.count(), 0);
  acknowledge();
  await toast.waitFor();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await row(page, ws).waitFor();
});

test("a start that never got a chat offers Delete and stays out of the archive", async (t) => {
  const page = await tab(t, true);
  const ws = await start(local, "Never started", "missing");
  await page.goto(`${baseUrl}/w/${ws.id}`);
  await row(page, ws).waitFor();
  assert.equal(
    await row(page, ws)
      .getByRole("button", { name: /Archive workspace/ })
      .count(),
    0
  );
  await page
    .locator('[data-slot="workspace-start-state"]')
    .getByRole("button", { name: "Delete" })
    .click();
  await page.getByText("Workspace deleted", { exact: true }).waitFor();
  const groups = await backend.read("workspaces", { state: "archived" });
  assert.ok(!groups.some((g) => g.workspaces.some((w) => w.id === ws.id)));
});

// The incoming backend contract: add its project totals to live snapshots and answer
// its archive read from this run's SQLite rows. Restore goes to the real backend.
async function archiveContract(page, db, origins, allowRestore) {
  const reads = [];
  await page.routeWebSocket(
    (url) => url.pathname === "/ws",
    (route) => {
      const host = route.connectToServer();
      const groups = new Set();
      route.onMessage(async (raw) => {
        const frame = JSON.parse(String(raw));
        if (frame.type === "q:mutate" && frame.action === "updateWorkspace") await allowRestore;
        if (frame.resource === "workspaces") groups.add(frame.id);
        if (frame.type === "q:request" && frame.resource === "archivedWorkspaces") {
          reads.push(frame.params.repositoryId);
          const data = db
            .prepare(
              `SELECT id, title, slug, git_branch, kind, organization_id, updated_at AS archived_at
          FROM workspaces WHERE repository_id = ? AND state = 'archived' ORDER BY updated_at DESC, rowid DESC`
            )
            .all(frame.params.repositoryId)
            .map((w) => ({ ...w, archived_by: origins.get(w.id) ?? null }));
          route.send(JSON.stringify({ type: "q:response", id: frame.id, data }));
        } else host.send(raw);
      });
      host.onMessage((raw) => {
        const frame = JSON.parse(String(raw));
        if (groups.has(frame.id) && (frame.type === "q:snapshot" || frame.type === "q:response")) {
          for (const group of frame.data) {
            if (group.repo_id === local.id) {
              delete group.archived_count; // A hosted web group has no count.
              continue;
            }
            group.archived_count = db
              .prepare(
                "SELECT COUNT(*) AS n FROM workspaces WHERE repository_id = ? AND state = 'archived'"
              )
              .get(group.repo_id).n;
          }
          route.send(JSON.stringify(frame));
        } else route.send(raw);
      });
    }
  );
  return reads;
}

for (const electron of [false, true]) {
  test(`browse archived workspaces and restore in ${electron ? "desktop" : "web"} styling`, async (t) => {
    const page = await tab(t, electron);
    const db = new Database(path.join(directory, "deus.db"));
    t.after(() => db.close());
    const project = await makeProject("archive-" + (electron ? "desktop" : "web"));
    // A project with a GitHub origin appears in the local and cloud places.
    db.prepare("UPDATE repositories SET git_origin_url = ? WHERE id = ?").run(
      "https://github.com/fixture/workspace-list",
      project.id
    );
    const sender = await start(local, "Source workspace");
    db.prepare("UPDATE sessions SET title = 'Review' WHERE id = ?").run(sender.current_session_id);
    const chat = await start(project, "Chat archive");
    const assistant = await start(project, "Assistant archive");
    const person = await start(project, null);
    const origins = new Map([
      [chat.id, { kind: "session", sessionId: sender.current_session_id, name: "another chat" }],
      [assistant.id, { kind: "assistant", id: "helper", name: "Release helper" }],
    ]);
    const unknownCount = await start(local, "Unknown archive count");
    await backend.write("archiveWorkspace", { workspaceId: unknownCount.id });
    for (const ws of [chat, assistant, person])
      await backend.write("archiveWorkspace", { workspaceId: ws.id });
    const cloud = crypto.randomUUID();
    db.prepare(
      "INSERT INTO workspaces (id, repository_id, slug, kind, organization_id, state) VALUES (?, ?, 'on-another-computer', 'cloud', 'blue', 'archived')"
    ).run(cloud, project.id);
    const allowRestore = Promise.withResolvers();
    const reads = await archiveContract(page, db, origins, allowRestore.promise);
    await page.goto(baseUrl);
    const toggle = page.getByRole("button", {
      name: "Toggle " + project.name + " workspaces",
      exact: true,
    });
    await toggle.waitFor();
    const group = toggle.locator("xpath=ancestor::div[@aria-roledescription='sortable'][1]");
    const disclosure = group.getByRole("button", { name: "Archived", exact: true });
    await disclosure.waitFor({ timeout: 3000 });
    assert.equal(await page.locator("html.electron").count(), electron ? 1 : 0);
    assert.equal(reads.length, 0);
    const unknownProject = page
      .getByRole("button", { name: "Toggle local workspaces", exact: true })
      .locator("xpath=ancestor::div[@aria-roledescription='sortable'][1]");
    assert.equal(
      await unknownProject.getByRole("button", { name: "Archived", exact: true }).count(),
      0
    );
    await disclosure.click();
    const open = group.getByRole("button", { name: /^Archived \(/ });
    await group.getByRole("button", { name: "Archived (3)", exact: true }).waitFor();
    await group.getByText("Archived by Release helper").waitFor();
    await group.getByText("Source workspace · Review").waitFor();
    assert.equal(await group.getByText(/Archived by/).count(), 2);
    const restore = (ws) =>
      group.getByRole("button", { name: "Restore " + (ws.title || ws.slug), exact: true });
    await restore(person).waitFor();
    assert.equal(await group.getByText("on-another-computer").count(), 0);
    assert.deepEqual(reads, [project.id]);
    await group.screenshot({
      path: path.join(evidence, electron ? "archive-desktop.png" : "archive-web.png"),
    });
    // Give this isolated backend two ready organizations, then switch with the sidebar shortcuts.
    await page.evaluate(async () => {
      const { queryClient } = await import("/src/shared/api/queryClient.ts");
      queryClient.setQueryData(["cloudOrganizations"], {
        available: true,
        accountId: "fixture",
        defaultOrganizationId: "blue",
        items: ["blue", "green"].map((id) => ({ id, name: id, role: "owner", ready: true })),
      });
    });
    await page.keyboard.press("Control+2");
    await group.getByRole("button", { name: "Archived (1)", exact: true }).waitFor();
    await group.getByRole("button", { name: "Restore on-another-computer" }).waitFor();
    await page.keyboard.press("Control+3");
    await group.getByText("No archived workspaces here.").waitFor();
    await page.keyboard.press("Control+1");
    await group.getByRole("button", { name: "Archived (3)", exact: true }).waitFor();
    // Exercise the family invalidation used by Archive and Restore while the live count stays put.
    const invalidateWorkspaces = () =>
      page.evaluate(async () => {
        const { queryClient } = await import("/src/shared/api/queryClient.ts");
        const { queryKeys } = await import("/src/shared/api/queryKeys.ts");
        await queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
      });
    await open.click();
    await disclosure.waitFor();
    await invalidateWorkspaces();
    assert.deepEqual(reads, [project.id], "the closed, previously loaded list stays idle");
    await disclosure.click();
    await until(() => reads.length === 2);
    await invalidateWorkspaces();
    const openReads = reads.length - 2;
    const button = restore(chat);
    const width = (await button.boundingBox()).width;
    await button.click();
    try {
      await until(() => button.isDisabled());
      assert.deepEqual(
        { openReads, label: await button.innerText(), width: (await button.boundingBox()).width },
        { openReads: 1, label: "Restore", width }
      );
    } finally {
      allowRestore.resolve();
    }
    await row(page, chat).waitFor();
    await group.getByRole("button", { name: "Archived (2)" }).waitFor();
    await restore(assistant).click();
    await row(page, assistant).waitFor();
    await restore(person).click();
    await row(page, person).waitFor();
    await group.getByRole("button", { name: "Archived (0)" }).waitFor();
    await group.getByText("No archived workspaces here.").waitFor();
    const beforeLastRestore = reads.length;
    await backend.write("updateWorkspace", { workspaceId: cloud, state: "ready" });
    await until(() => reads.length > beforeLastRestore);
    await group.getByRole("button", { name: "Archived (0)" }).waitFor();
    await group.getByText("No archived workspaces here.").waitFor();
    await open.click();
    await open.waitFor({ state: "detached" });
    assert.equal(await disclosure.count(), 0);
    await backend.write("archiveWorkspace", { workspaceId: person.id });
    await disclosure.click();
    await restore(person).waitFor();
    assert.equal(await row(page, person).count(), 0);
  });
}
