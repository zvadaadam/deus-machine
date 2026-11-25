/* global document, window */
// Run: node --import tsx test/e2e/workspace-list.browser.mjs (Node SQLite ABI).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rename, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import Database from "better-sqlite3";
import { chromium } from "playwright";
import { createServer } from "vite";
import { queryKeys } from "../../apps/web/src/shared/api/queryKeys.ts";
import { connectBackend } from "./lib/operations.mjs";
import { createStack, freePort, until } from "./remote-access/stack.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const evidence = path.join(root, ".context/workspace-list");
await mkdir(evidence, { recursive: true });
const directory = await mkdtemp(path.join(evidence, "run-"));
const database = path.join(directory, "deus.db");
const stack = createStack({ root, directory });
const spawnToken = crypto.randomUUID();
let backend, db, server, browser, host, baseUrl, local, remote, offline, upstream;

async function makeProject(name, remoteUrl, remoteName = "origin") {
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
  if (remoteUrl) git("remote", "add", remoteName, remoteUrl);
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

async function startBackend(port = "0") {
  host = await stack.host({
    name: "backend",
    authToken: spawnToken,
    database,
    dir: directory,
    env: {
      PORT: port,
      DEUS_USER_DATA_DIR: directory,
      TMPDIR: directory,
      DEUS_BUNDLED_BIN_DIR: path.join(root, "test/e2e/fixtures/github"),
      DEUS_TEST_MERGED_HEAD: path.join(directory, "merged-head"),
    },
  });
  backend = await connectBackend(host.url);
}

before(async () => {
  await writeFile(
    path.join(directory, "preferences.json"),
    JSON.stringify({ onboarding_completed: true, remote_access_enabled: false })
  );
  await startBackend();
  db = new Database(database);
  local = await makeProject("local");
  const bare = path.join(directory, "origin.git");
  execFileSync("git", ["clone", "--bare", local.root_path, bare], { stdio: "pipe" });
  remote = await makeProject("remote", bare);
  upstream = await makeProject("upstream", bare, "upstream");
  offline = await makeProject("offline", path.join(directory, "missing.git"));
  server = await createServer({
    configFile: path.join(root, "apps/web/vite.config.ts"),
    cacheDir: path.join(directory, "vite-cache"),
    logLevel: "error",
    define: { "import.meta.env.VITE_BACKEND_PORT": JSON.stringify(new URL(host.url).port) },
    server: { host: "127.0.0.1", port: await freePort(), fs: { allow: [root] } },
  });
  await server.listen();
  baseUrl = server.resolvedUrls.local[0] + "s/local";
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await server?.close();
  backend?.close();
  db?.close();
  await stack.close();
});

async function tab(t, mode = "web") {
  const phone = mode === "phone";
  const context = await browser.newContext({
    viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    hasTouch: phone,
    isMobile: phone,
    colorScheme: "light",
  });
  t.after(() => context.close());
  if (mode === "desktop")
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
const archiveButton = (page, ws) =>
  row(page, ws).getByRole("button", { name: /Archive workspace/ });

async function openWorkspaceTool(page, name) {
  const strip = page.getByRole("tablist", { name: "Workspace tabs" });
  await strip.waitFor();
  const existing = strip.getByRole("tab", { name, exact: true });
  if ((await existing.count()) > 0) {
    await existing.click();
    return;
  }
  const newTabView = page.locator('[data-slot="new-tab-view"]');
  if (!(await newTabView.isVisible())) {
    await page.getByRole("button", { name: "New tab", exact: true }).click();
    await newTabView.waitFor();
  }
  await newTabView.getByRole("button", { name, exact: true }).click();
  await existing.waitFor();
}

test("a linked chat leaves the saved tab unread and shows its background work", async (t) => {
  const page = await tab(t);
  const ws = await start(local, "Linked chat");
  const saved = ws.current_session_id;
  const { id: linked } = await backend.write("createSession", { workspaceId: ws.id });
  await page.goto(baseUrl);
  await page.getByRole("button", { name: "Toggle local workspaces", exact: true }).waitFor();
  await page.evaluate(
    async ({ workspace, saved, linked }) => {
      const { workspaceLayoutActions } = await import(
        `${window.location.origin}/src/features/workspace/store/workspaceLayoutStore.ts`
      );
      const { unreadActions } = await import(
        `${window.location.origin}/src/features/session/store/unreadStore.ts`
      );
      workspaceLayoutActions.setChatTabState(workspace, [saved, linked], saved);
      unreadActions.markUnread(saved);
      unreadActions.markUnread(linked);
    },
    { workspace: ws.id, saved, linked }
  );
  await page.goto(`${baseUrl}/w/${ws.id}?session=${linked}`);
  const tabs = page.getByRole("tablist", { name: "Session tabs" });
  await tabs.getByRole("tab").nth(1).and(page.locator('[aria-selected="true"]')).waitFor();
  const unread = await page.evaluate(
    () => JSON.parse(localStorage.getItem("unread-sessions-store")).state.unreadSessionIds
  );
  assert.deepEqual(unread, { [saved]: true });

  const setStatus = db.prepare("UPDATE sessions SET status = ? WHERE id = ?");
  setStatus.run("working", saved);
  t.after(() => setStatus.run("idle", saved));
  await backend.write("updateWorkspaceTitle", {
    workspaceId: ws.id,
    title: "Background chat working",
  });
  await tabs.getByRole("tab").first().locator("..").locator("canvas").waitFor();
  assert.equal(await tabs.getByRole("tab").nth(1).locator("..").locator("canvas").count(), 0);

  await page.goto(baseUrl);
  await page.getByLabel("Message to start a new workspace").waitFor();
  const waitForAdditions = (count) =>
    page.waitForFunction(
      async ({ key, count }) => {
        const { queryClient } = await import(
          `${window.location.origin}/src/shared/api/queryClient.ts`
        );
        return queryClient.getQueryData(key)?.additions === count;
      },
      { key: queryKeys.workspaces.diffStats(ws.id), count },
      { timeout: 15_000 }
    );
  await waitForAdditions(0);
  await writeFile(path.join(ws.workspace_path, "release.txt"), "Ready for review\n");
  await waitForAdditions(1);
});

test("a reconnect keeps a half-answered question and removes a withdrawn one", async (t) => {
  const page = await tab(t);
  const ws = await start(local, "Answer a question");
  const sessionId = ws.current_session_id;
  let connection, push, answer;
  let subscriptions = 0;
  await page.routeWebSocket(/\/ws$/, (route) => {
    const host = route.connectToServer();
    route.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === "q:subscribe" && frame.resource === "toolRequests") {
        connection = route;
        subscriptions++;
        push = (data) =>
          route.send(
            JSON.stringify({ type: "q:event", id: frame.id, event: frame.resource, data })
          );
      } else if (frame.type === "q:tool_response") answer = frame.result;
      else host.send(raw);
    });
  });
  async function reconnect() {
    const before = subscriptions;
    await connection.close({ code: 1012, reason: "reconnect" });
    await until(() => subscriptions > before, 15_000, "the card stream to reopen");
  }
  const question = (requestId) => ({
    type: "request",
    request: {
      requestId,
      sessionId,
      method: "askUserQuestion",
      timeoutMs: 60_000,
      params: {
        sessionId,
        questions: [
          { question: "Which branch?", options: ["Main", "Release"] },
          { question: "What should the note say?", options: [] },
        ],
      },
    },
  });
  await page.goto(`${baseUrl}/w/${ws.id}`);
  await page.locator('[data-slot="workspace-chat-pane"] textarea').waitFor();
  await until(() => !!push, 15_000, "the card stream");
  push(question("keep"));
  await page.getByRole("button", { name: "Release", exact: true }).click();
  const note = page
    .getByRole("dialog", { name: "Agent question" })
    .filter({ hasText: "What should the note say?" });
  await note.getByRole("button", { name: "Type a custom answer" }).click();
  const input = note.getByRole("textbox", { name: "Custom answer" });
  await input.fill("Ship after review");
  await reconnect();
  assert.equal(await input.count(), 1, "the answer field stays mounted until the host replies");
  assert.equal(await input.inputValue(), "Ship after review");
  push({ type: "pending", requestIds: ["keep"] });
  push(question("keep"));
  await input.press("Enter");
  await until(() => !!answer, 5000, "the completed answer");
  assert.deepEqual(answer, { answers: ["Release", "Ship after review"] });

  push(question("withdraw"));
  const first = page.getByRole("button", { name: "Release", exact: true });
  await first.click();
  await reconnect();
  push({ type: "pending", requestIds: [] });
  await page.getByText("What should the note say?", { exact: true }).waitFor({ state: "detached" });
});

test("Changes keeps the missing checkout error until a read succeeds", async (t) => {
  const page = await tab(t);
  const other = await start(local, "Files");
  const ws = await start(local, "Unavailable checkout");
  const file = "recovered.txt";
  const reason = "Could not read the changes: git failed (ENOENT).";
  await writeFile(path.join(ws.workspace_path, file), "Change to recover\n");
  await page.goto(`${baseUrl}/w/${other.id}`);
  await openWorkspaceTool(page, "Files");

  const displays = await page.evaluateHandle(
    (labels) => {
      const seen = [];
      const sample = () => {
        const text = document.body.innerText;
        const display = labels.find((label) => text.includes(label)) ?? null;
        if (seen.at(-1) !== display) seen.push(display);
      };
      new window.MutationObserver(sample).observe(document.body, {
        childList: true,
        characterData: true,
        subtree: true,
      });
      sample();
      return seen;
    },
    ["No file changes yet", reason, file]
  );

  const moved = ws.workspace_path + "-aside";
  await rename(ws.workspace_path, moved);
  try {
    await row(page, ws).click();
    await openWorkspaceTool(page, "Changes");
    // The first failed read and two completed polls, regardless of per-read retries.
    const cache = await page.evaluateHandle(
      async () =>
        (await import(`${window.location.origin}/src/shared/api/queryClient.ts`)).queryClient
    );
    await page.waitForFunction(
      ({ cache, key }) => cache.getQueryState(key)?.errorUpdateCount >= 3,
      { cache, key: queryKeys.workspaces.diffFiles(ws.id) }
    );
  } finally {
    await rename(moved, ws.workspace_path);
  }
  await page.getByText(file, { exact: true }).first().waitFor();
  assert.deepEqual(await displays.jsonValue(), [null, reason, file]);
});

for (const project of ["local", "remote", "offline", "upstream"]) {
  test(`start details for ${project}`, async (t) => {
    const page = await tab(t, "desktop");
    await page.goto(baseUrl);
    await page.getByRole("button", { name: `New workspace in ${project}`, exact: true }).click();
    const composer = page.getByLabel("Message to start a new workspace");
    await composer.fill(`Start in ${project}`);
    const appearances = await page.evaluateHandle(() => {
      const seen = [];
      new window.MutationObserver(() => {
        const header = document.querySelector('[data-slot="workspace-tool-header"]');
        if (!header?.innerText.split("\n").includes("Create PR")) return;
        const phase = document.querySelector('[data-slot="workspace-start-state"]')
          ? "starting"
          : "ready";
        if (seen.at(-1) !== phase) seen.push(phase);
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
      return seen;
    });
    // Hold git before it creates the worktree, so the window sees a start without a checkout.
    const repo = { local, remote, offline, upstream }[project];
    const hooks = path.join(repo.root_path, ".git", "hooks");
    execFileSync("git", ["config", "core.hooksPath", hooks], { cwd: repo.root_path });
    const gate = path.join(hooks, "reference-transaction");
    await writeFile(gate, '#!/bin/sh\nwhile test ! -f "$0.release"; do sleep 0.05; done\n', {
      mode: 0o755,
    });
    try {
      await composer.press("Enter");
      await page.locator('[data-slot="workspace-start-state"][data-state="starting"]').waitFor();
    } finally {
      await writeFile(gate + ".release", "");
    }
    const group = page.locator('#chat-messages [data-slot="env-group"]');
    const expand = group.getByRole("button", { name: "Workspace ready" });
    if ((await expand.getAttribute("aria-expanded")) === "false") await expand.click();
    await group.getByText("Made a safe copy").waitFor();
    assert.equal(
      (await group.getByText("Copy may be out of date", { exact: true }).count()) > 0,
      project === "offline"
    );
    if (project === "local") {
      const selected = page.locator('[data-workspace-id][aria-current="page"]');
      await waitForPRRead(page, await selected.getAttribute("data-workspace-id"), false);
      assert.deepEqual(await appearances.jsonValue(), []);
    } else if (project === "remote" || project === "upstream") {
      await page.getByRole("button", { name: "Create PR", exact: true }).waitFor();
      assert.deepEqual(await appearances.jsonValue(), ["ready"]);
    }
    assert.equal(
      await group.getByText("No origin to check", { exact: true }).count(),
      project === "local" || project === "upstream" ? 1 : 0,
      await group.innerText()
    );
    assert.equal(
      await group.getByText("Checked for the latest changes").count(),
      project === "remote" ? 1 : 0
    );
  });
}

async function waitForPRRead(page, workspaceId, conclusive) {
  await until(
    () =>
      page.evaluate(
        async ({ workspaceId, conclusive }) => {
          const { queryClient } = await import(
            `${window.location.origin}/src/shared/api/queryClient.ts`
          );
          const { queryKeys } = await import(
            `${window.location.origin}/src/shared/api/queryKeys.ts`
          );
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
    const page = await tab(t, mode);
    const ws = await start(local, "Header");
    let answer;
    await page.routeWebSocket(/\/ws$/, (route) => {
      const host = route.connectToServer();
      route.onMessage((raw) => {
        const f = JSON.parse(String(raw));
        if (!answer && f.type === "q:request" && f.resource === "prStatus")
          answer = () => host.send(raw);
        else host.send(raw);
      });
    });
    await page.goto(`${baseUrl}/w/${ws.id}`);
    await page.locator('[data-slot="workspace-header"]').waitFor();
    await until(() => !!answer, 10_000, "the first PR read");
    const createPR = page.getByRole("button", { name: "Create PR", exact: true });
    assert.equal(await createPR.count(), 0, "no Create PR while the first read is pending");
    answer();
    await waitForPRRead(page, ws.id, false);
    assert.equal(
      await page
        .locator(
          '[data-slot="workspace-header"] .animate-spin, [data-slot="workspace-tool-header"] .animate-spin'
        )
        .count(),
      0
    );
    assert.equal(await createPR.count(), 0);
    if (mode === "phone") {
      await page.getByRole("button", { name: "Expand sidebar" }).tap();
      const archive = archiveButton(page, ws);
      await archive.waitFor();
      assert.equal(
        await archive.evaluate((button) => window.getComputedStyle(button).opacity),
        "1",
        "Archive is visible on touch before the person points at the row"
      );
      await archive.tap();
      await page.getByText("Workspace archived", { exact: true }).waitFor();
      await row(page, ws).waitFor({ state: "detached" });
      assert.equal((await backend.read("workspace", { workspaceId: ws.id })).state, "archived");
      await page.getByRole("button", { name: "Undo", exact: true }).tap();
      await page.getByRole("button", { name: "Expand sidebar" }).tap();
      await row(page, ws).waitFor();
    }
  });
}

test("Enter on the sidebar Archive button archives the workspace", async (t) => {
  const page = await tab(t, "desktop");
  const ws = await start(local, "Keyboard archive");
  await page.goto(`${baseUrl}/w/${ws.id}`);
  await archiveButton(page, ws).focus();
  await page.keyboard.press("Enter");
  await page.getByText("Workspace archived", { exact: true }).waitFor();
  const project = page.getByLabel("Toggle local workspaces", { exact: true });
  assert.equal(await project.getAttribute("aria-expanded"), "true");
  assert.equal((await backend.read("workspace", { workspaceId: ws.id })).state, "archived");
});

test("a detached HEAD with a remote still offers Create PR", async (t) => {
  const page = await tab(t);
  const ws = await start(remote, "Detached checkout");
  execFileSync("git", ["switch", "--detach"], { cwd: ws.workspace_path, stdio: "pipe" });
  await page.goto(`${baseUrl}/w/${ws.id}`);
  await waitForPRRead(page, ws.id, false);
  await page.getByRole("button", { name: "Create PR", exact: true }).waitFor();
});

test("an idle workspace discovers a newly added remote when the window regains focus", async (t) => {
  const page = await tab(t);
  const ws = await start(local, "PR on focus");
  assert.equal(ws.session_status, "idle");
  await page.goto(`${baseUrl}/w/${ws.id}`);
  await waitForPRRead(page, ws.id, false);
  const button = page.getByRole("button", { name: "Create PR", exact: true });
  assert.equal(await button.count(), 0);
  // A custom remote is enough for gh; the project's recorded origin is still null.
  const git = (...args) => execFileSync("git", args, { cwd: ws.workspace_path, stdio: "pipe" });
  git("remote", "add", "publish", remote.git_origin_url);
  try {
    // The tab returns after the cached PR answer has gone stale.
    await page.clock.setFixedTime(new Date(Date.now() + 60_000));
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange", { bubbles: true }))
    );
    await button.waitFor({ timeout: 5000 });
  } finally {
    git("remote", "remove", "publish");
  }
});

async function general(page) {
  await page.goto(baseUrl);
  await page.getByRole("button", { name: "Toggle local workspaces", exact: true }).waitFor();
  await page.evaluate(async () => {
    const { useUIStore } = await import(`${window.location.origin}/src/shared/stores/uiStore.ts`);
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
      await page.evaluate(() => {
        window.electronAPI.checkForUpdates = async () => {
          throw new Error("net::ERR_INTERNET_DISCONNECTED");
        };
      });
      await check.click();
      await page.getByText("Couldn't get the latest update. Deus will try again.").waitFor();
    }
  });
}

for (const failureFirst of [false, true]) {
  test(`a failed removal preserves live rows with the ${failureFirst ? "failure" : "success"} reply first`, async (t) => {
    const page = await tab(t, failureFirst ? "desktop" : "web");
    const project = await makeProject(
      failureFirst ? "archive-refusal" : "delete-refusal",
      failureFirst ? local.root_path : undefined
    );
    const source = failureFirst ? "main" : "missing";
    const a = await start(failureFirst ? project : local, "A", source);
    const b = await start(failureFirst ? local : project, "B", source);
    const c = await start(local, "Witness");
    const saved = await start(project, "Already archived");
    await backend.write("archiveWorkspace", { workspaceId: saved.id });

    // B's cloud computer has to finish pausing before its archive can commit.
    let finishPause;
    if (failureFirst) {
      await writeFile(path.join(directory, "merged-head"), a.git_branch);
      const platform = createHttpServer((req, res) => {
        if (req.method === "POST" && req.url.endsWith(`/workspaces/${b.id}/pause`)) {
          finishPause = () =>
            res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
        } else res.writeHead(404).end();
      });
      await new Promise((resolve) => platform.listen(0, "127.0.0.1", resolve));
      const credentials = (body) =>
        host.api("/settings/cloud/credentials", {
          method: "POST",
          headers: { authorization: `Bearer ${spawnToken}` },
          body,
        });
      t.after(async () => {
        platform.closeAllConnections();
        await new Promise((resolve) => platform.close(resolve));
        await credentials({ baseUrl: null, orgKeys: null });
      });
      await credentials({
        baseUrl: `http://127.0.0.1:${platform.address().port}`,
        orgKeys: { blue: "fixture" },
      });
      db.prepare("UPDATE workspaces SET kind = 'cloud' WHERE id IN (?, ?, ?)").run(
        a.id,
        b.id,
        c.id
      );
      db.prepare("UPDATE workspaces SET provider_workspace_id = ? WHERE id = ?").run(b.id, b.id);
    }

    // Unrelated session deltas arrive while A is pending. All one-shot reads reach the host.
    let refuseA;
    let simulatorStops = 0;
    const simulatorSession = {
      phase: "streaming",
      udid: "fixture",
      stream: { url: "about:blank", hid_available: true },
    };
    await page.routeWebSocket(
      (url) => url.pathname === "/ws",
      (route) => {
        const server = route.connectToServer();
        const groups = new Set();
        let aRequest;
        route.onMessage((raw) => {
          const f = JSON.parse(String(raw));
          if (f.resource === "workspaces") groups.add(f.id);
          if (f.action === "simStop") simulatorStops++;
          if (
            f.type === "q:mutate" &&
            f.params.workspaceId === a.id &&
            ["archiveWorkspace", "deleteWorkspace"].includes(f.action)
          ) {
            // Exercise the backend's refusal through the same mutation as a stale window.
            aRequest = f.id;
            server.send(JSON.stringify({ ...f, params: { workspaceId: "missing" } }));
            return;
          }
          server.send(raw);
        });
        server.onMessage((raw) => {
          const f = JSON.parse(String(raw));
          if (f.id === aRequest && f.type === "q:mutate_result") {
            refuseA = () => route.send(raw);
          } else if (groups.has(f.id) && (f.type === "q:snapshot" || f.type === "q:response")) {
            if (f.type === "q:snapshot" && refuseA) {
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
            } else route.send(raw);
          } else route.send(raw);
        });
      }
    );
    await page.goto(failureFirst ? `${baseUrl}/w/${a.id}` : baseUrl);
    const remove = async (ws) => {
      if (ws.state === "error") {
        await row(page, ws).click();
        await page
          .locator('[data-slot="workspace-start-state"]')
          .getByRole("button", { name: "Delete" })
          .click();
      } else {
        await archiveButton(page, ws).click();
      }
    };
    if (failureFirst) {
      const button = page.getByRole("button", { name: "Archive", exact: true });
      await page.evaluate(
        async ([id, session]) => {
          const { simulatorStoreActions } = await import(
            `${window.location.origin}/src/features/simulator/store.ts`
          );
          simulatorStoreActions.setSession(id, session);
        },
        [a.id, simulatorSession]
      );
      await button.click();
    } else await remove(a);
    await until(() => !!refuseA);
    await row(page, a).waitFor({ state: "detached" });
    await backend.write("updateWorkspaceTitle", { workspaceId: b.id, title: "B live" });
    await row(page, b).getByText("B live").waitFor();
    await backend.write("updateWorkspaceTitle", { workspaceId: c.id, title: "Witness live" });
    await row(page, c).getByText("Witness live").waitFor();
    const projectState = (refetch = false) =>
      page.evaluate(
        async ({ id, refetch }) => {
          const { queryClient } = await import(
            `${window.location.origin}/src/shared/api/queryClient.ts`
          );
          const { queryKeys } = await import(
            `${window.location.origin}/src/shared/api/queryKeys.ts`
          );
          const { SIDEBAR_WORKSPACE_STATE } = await import(
            `${window.location.origin}/src/features/workspace/api/workspace.queries.ts`
          );
          const queryKey = queryKeys.workspaces.byRepo(SIDEBAR_WORKSPACE_STATE);
          if (refetch) await queryClient.refetchQueries({ queryKey });
          const group = queryClient.getQueryData(queryKey).find((g) => g.repo_id === id);
          return [group?.archived_count, group?.workspaces.map((w) => w.id)];
        },
        { id: project.id, refetch }
      );
    assert.equal((await projectState())[0], 1, "session deltas keep the project's archive count");
    assert.equal(await row(page, a).count(), 0);
    await remove(b);
    await row(page, b).waitFor({ state: "detached" });
    if (failureFirst) await until(() => !!finishPause, 10_000, "the cloud computer is pausing");
    else await page.getByText("Workspace deleted", { exact: true }).waitFor();
    refuseA();
    await page.getByText("Workspace not found", { exact: true }).waitFor();
    await row(page, a).waitFor();
    if (failureFirst) {
      assert.deepEqual(
        await page.evaluate(
          async ([id, otherId, udid]) => {
            const { simulatorStoreActions } = await import(
              `${window.location.origin}/src/features/simulator/store.ts`
            );
            return [
              simulatorStoreActions.getSession(id),
              simulatorStoreActions.getWorkspaceByUdid(udid, otherId),
            ];
          },
          [a.id, b.id, simulatorSession.udid]
        ),
        [simulatorSession, a.id],
        "a refused archive keeps the stream and its device claim"
      );
      assert.equal(simulatorStops, 0);
      assert.equal((await backend.read("workspace", { workspaceId: b.id })).state, "ready");
      // Mark the real read so the assertion waits until its answer is on screen.
      db.prepare("UPDATE workspaces SET title = 'Witness read' WHERE id = ?").run(c.id);
      await projectState(true);
      await row(page, c).getByText("Witness read").waitFor();
      assert.equal(
        await row(page, b).count(),
        0,
        "the real read must not reveal B before its archive commits"
      );
      finishPause();
      await page.getByText("Workspace archived", { exact: true }).waitFor();
    }
    assert.equal(await row(page, b).count(), 0, "B stayed removed");
    await row(page, c)
      .getByText(failureFirst ? "Witness read" : "Witness live")
      .waitFor();
    assert.deepEqual(await projectState(), [1, failureFirst ? [a.id] : []]);
  });
}

test("a confirmed archive frees the simulator for another workspace", async (t) => {
  const page = await tab(t);
  const a = await start(remote, "Archive while streaming");
  const b = await start(local, "Next simulator workspace");
  await writeFile(path.join(directory, "merged-head"), a.git_branch);
  const device = {
    udid: "fixture",
    name: "iPhone",
    device_type: "iPhone",
    runtime: "iOS",
    state: "Shutdown",
    is_available: true,
  };
  const reads = {
    settings: { ...(await backend.read("settings")), experimental_simulator: true },
    simulatorCapabilities: { available: true, unavailableReason: null },
    simListDevices: { devices: [device] },
  };
  const starts = [];
  // A single simulated device keeps Start on the real panel without booting a simulator on the host.
  await page.routeWebSocket(/\/ws$/, (route) => {
    const host = route.connectToServer();
    const send = (frame) => route.send(JSON.stringify(frame));
    const subscribers = new Map();
    route.onMessage((raw) => {
      const f = JSON.parse(String(raw));
      if (f.type === "q:request" && Object.hasOwn(reads, f.resource))
        return send({ type: "q:response", id: f.id, data: reads[f.resource] });
      if (f.type === "q:subscribe" && f.resource === "simulatorEvents")
        subscribers.set(f.params.workspaceId, f.id);
      if (f.action === "simStart") {
        starts.push([f.params.workspaceId, f.params.udid]);
        send({ type: "q:mutate_result", id: f.id, success: true });
        return send({
          type: "q:event",
          event: "simulatorEvents",
          id: subscribers.get(f.params.workspaceId),
          data: { type: "streamReady", url: "about:blank", hidAvailable: true },
        });
      }
      host.send(raw);
    });
  });
  const startSimulator = async () => {
    await openWorkspaceTool(page, "Simulator");
    await page.getByRole("button", { name: "Start Simulator", exact: true }).click();
    const status = page
      .getByLabel("Simulator streaming")
      .or(
        page.getByText("That simulator is already in use by another workspace.", { exact: true })
      );
    await status.waitFor();
    assert.equal(
      await status.getAttribute("aria-label"),
      "Simulator streaming",
      await status.textContent()
    );
  };
  await page.goto(`${baseUrl}/w/${a.id}`);
  await startSimulator();
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await page.getByText("Workspace archived", { exact: true }).waitFor();
  await row(page, b).click();
  await startSimulator();
  assert.deepEqual(starts, [
    [a.id, device.udid],
    [b.id, device.udid],
  ]);
});

for (const loseReply of [false, true]) {
  test(
    loseReply
      ? "a committed archive stays absent when its acknowledgement is lost"
      : "the header archive changes its pending toast to Undo when the backend confirms it",
    async (t) => {
      const page = await tab(t);
      const ws = await start(
        loseReply ? local : remote,
        loseReply ? "Lost archive reply" : "Undo archive"
      );
      if (!loseReply) await writeFile(path.join(directory, "merged-head"), ws.git_branch);
      const reconnect = Promise.withResolvers();
      const reconnectedProject = "Project after reconnect";
      let finish, snapshotBeforeReply;
      await page.routeWebSocket(/\/ws$/, (route) => {
        const host = route.connectToServer();
        const reconnecting = !!finish;
        let mutation,
          subscription,
          removed = false;
        route.onMessage((raw) => {
          const f = JSON.parse(String(raw));
          if (f.type === "q:subscribe" && f.resource === "workspaces") subscription = f.id;
          if (f.type === "q:mutate" && f.action === "archiveWorkspace") mutation = f.id;
          host.send(raw);
        });
        host.onMessage(async (raw) => {
          if (reconnecting) await reconnect.promise;
          const f = JSON.parse(String(raw));
          if (f.type === "q:snapshot" && f.id === subscription) {
            removed = !f.data.some((g) => g.workspaces.some((w) => w.id === ws.id));
            if (reconnecting && removed) {
              // The new project name shows when the sidebar has rendered this snapshot.
              f.data.find((g) => g.repo_id === ws.repository_id).repo_name = reconnectedProject;
              return route.send(JSON.stringify(f));
            }
          }
          if (f.type === "q:mutate_result" && f.id === mutation && f.success) {
            snapshotBeforeReply = removed;
            finish = () => {
              if (loseReply) {
                route.close({ code: 1011, reason: "Lost archive acknowledgement" });
                host.close();
              } else route.send(raw);
            };
          } else route.send(raw);
        });
      });
      await page.goto(loseReply ? baseUrl : `${baseUrl}/w/${ws.id}`);
      if (loseReply) await archiveButton(page, ws).click();
      else await page.getByRole("button", { name: "Archive", exact: true }).click();
      await until(() => !!finish);
      assert.equal(
        snapshotBeforeReply,
        true,
        "the host sent the removal before its acknowledgement"
      );
      const toast = page.getByText("Workspace archived", { exact: true });
      assert.equal(await toast.count(), 0);
      const pending = page.locator("[data-sonner-toast]").filter({ hasText: "Archiving…" });
      await pending.waitFor({ timeout: 3000 });
      const toastNode = await pending.elementHandle();
      finish();
      if (loseReply) {
        try {
          await page.getByText(/operation may have completed/i).waitFor();
          assert.match(await toastNode.textContent(), /operation may have completed/i);
          assert.equal(
            await row(page, ws).count(),
            0,
            "losing the reply must not undo a confirmed snapshot"
          );
        } finally {
          reconnect.resolve();
        }
        await page.waitForFunction(
          ({ id, name }) => {
            if (document.querySelector(`[data-workspace-id="${id}"]`))
              throw new Error("The archived workspace reappeared on reconnect");
            return !!document.querySelector(`[aria-label="Toggle ${name} workspaces"]`);
          },
          { id: ws.id, name: reconnectedProject },
          { timeout: 15_000 }
        );
      } else {
        await toast.waitFor();
        assert.ok(
          await toastNode.evaluate((node) => node.textContent.includes("Workspace archived"))
        );
        await page.getByRole("button", { name: "Undo", exact: true }).click();
        await row(page, ws).waitFor();
      }
    }
  );
}

test("a start that never got a chat offers Delete and stays out of the archive", async (t) => {
  const page = await tab(t, "desktop");
  const ws = await start(local, "Never started", "missing");
  assert.equal(ws.start_recoverable, true);
  await page.goto(`${baseUrl}/w/${ws.id}`);
  await row(page, ws).waitFor();
  assert.equal(await archiveButton(page, ws).count(), 0);
  await page
    .locator('[data-slot="workspace-start-state"]')
    .getByRole("button", { name: "Delete" })
    .click();
  await page.getByText("Workspace deleted", { exact: true }).waitFor();
  const groups = await backend.read("workspaces", { state: "archived" });
  assert.ok(!groups.some((g) => g.workspaces.some((w) => w.id === ws.id)));
});

test("a failed workspace with a chat and an empty pointer can only be archived", async (t) => {
  const ws = await start(local, "Failed with a chat", "missing");
  db.prepare("INSERT INTO sessions (id, workspace_id) VALUES (?, ?)").run(
    crypto.randomUUID(),
    ws.id
  );
  const page = await tab(t);
  await page.goto(`${baseUrl}/w/${ws.id}`);
  const failure = page.locator('[data-slot="workspace-start-state"]');
  await failure.getByText("Workspace didn't start", { exact: true }).waitFor();
  assert.deepEqual(
    {
      retry: await failure.getByRole("button", { name: "Retry" }).count(),
      delete: await failure.getByRole("button", { name: "Delete" }).count(),
      archive: await archiveButton(page, ws).count(),
    },
    { retry: 0, delete: 0, archive: 1 }
  );
  assert.equal((await backend.read("workspace", { workspaceId: ws.id })).start_recoverable, false);
  await archiveButton(page, ws).click();
  await page.getByText("Workspace archived", { exact: true }).waitFor();
});

async function observeArchiveReads(page, allowRestore) {
  const reads = { archives: [], workspaces: 0 };
  await page.routeWebSocket(/\/ws$/, (route) => {
    const host = route.connectToServer();
    const groups = new Set();
    route.onMessage(async (raw) => {
      const f = JSON.parse(String(raw));
      if (f.type === "q:mutate" && f.action === "updateWorkspace") await allowRestore;
      if (f.resource === "workspaces") {
        groups.add(f.id);
        if (f.type === "q:request") reads.workspaces++;
      }
      if (f.type === "q:request" && f.resource === "archivedWorkspaces")
        reads.archives.push(f.params.repositoryId);
      host.send(raw);
    });
    host.onMessage((raw) => {
      const f = JSON.parse(String(raw));
      if (groups.has(f.id) && (f.type === "q:snapshot" || f.type === "q:response")) {
        // Only the hosted web builds groups without a count.
        delete f.data.find((group) => group.repo_id === local.id).archived_count;
        route.send(JSON.stringify(f));
      } else route.send(raw);
    });
  });
  return reads;
}

for (const mode of ["web", "desktop"]) {
  test(`browse archived workspaces and restore in ${mode} styling`, async (t) => {
    const project = await makeProject("archive-" + mode);
    // A project with a GitHub origin appears in the local and cloud places.
    db.prepare("UPDATE repositories SET git_origin_url = ? WHERE id = ?").run(
      "https://github.com/fixture/workspace-list",
      project.id
    );
    const sender = await start(local, "Source workspace");
    const other = await start(local, "Archive while closed");
    db.prepare("UPDATE sessions SET title = 'Review' WHERE id = ?").run(sender.current_session_id);
    const chat = await start(project, "Chat archive");
    const assistant = await start(project, "Assistant archive");
    const person = await start(project, null);
    const unknownCount = await start(local, "Unknown archive count");
    await backend.write("archiveWorkspace", { workspaceId: unknownCount.id });
    for (const ws of [chat, assistant, person])
      await backend.write("archiveWorkspace", { workspaceId: ws.id });
    // This runner connects as the person's window. The assistants' host records these two origins.
    const by = db.prepare("UPDATE workspaces SET archived_by = ? WHERE id = ?");
    by.run(JSON.stringify({ kind: "session", sessionId: sender.current_session_id }), chat.id);
    by.run(
      JSON.stringify({ kind: "assistant", id: "helper", name: "Release helper" }),
      assistant.id
    );
    if (mode === "web") {
      const { port } = new URL(host.url);
      backend.close();
      await stack.stop(host);
      await startBackend(port);
    }
    const page = await tab(t, mode);
    const cloud = crypto.randomUUID();
    db.prepare(
      "INSERT INTO workspaces (id, repository_id, slug, kind, organization_id, state) VALUES (?, ?, 'on-another-computer', 'cloud', 'blue', 'archived')"
    ).run(cloud, project.id);
    const allowRestore = Promise.withResolvers();
    const reads = await observeArchiveReads(page, allowRestore.promise);
    await page.goto(baseUrl);
    const toggle = page.getByRole("button", {
      name: "Toggle " + project.name + " workspaces",
      exact: true,
    });
    await toggle.waitFor();
    const group = toggle.locator("xpath=ancestor::div[@data-slot='collapsible'][1]");
    const disclosure = group.getByRole("button", { name: "Archived", exact: true });
    await disclosure.waitFor({ timeout: 3000 });
    assert.equal(await page.locator("html.electron").count(), mode === "desktop" ? 1 : 0);
    assert.equal(reads.archives.length, 0);
    const unknownProject = page
      .getByRole("button", { name: "Toggle local workspaces", exact: true })
      .locator("xpath=ancestor::div[@data-slot='collapsible'][1]");
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
    assert.deepEqual(reads.archives, [project.id]);
    await group.screenshot({
      path: path.join(evidence, `archive-${mode}.png`),
    });
    // Give this isolated backend two ready organizations, then switch with the sidebar shortcuts.
    await page.evaluate(async () => {
      const { queryClient } = await import(
        `${window.location.origin}/src/shared/api/queryClient.ts`
      );
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
    // Archive in another project so this one's live count stays put.
    const sidebarReads = reads.workspaces;
    await open.click();
    await disclosure.waitFor();
    await archiveButton(page, other).click();
    await page.getByText("Workspace archived", { exact: true }).waitFor();
    assert.deepEqual(reads.archives, [project.id], "the closed, previously loaded list stays idle");
    await disclosure.click();
    await until(() => reads.archives.length === 2);
    await archiveButton(page, sender).click();
    await until(() => reads.archives.length === 3);
    const button = restore(chat);
    const width = (await button.boundingBox()).width;
    await button.click();
    try {
      await until(() => button.isDisabled());
      assert.deepEqual(
        { label: await button.innerText(), width: (await button.boundingBox()).width },
        { label: "Restore", width }
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
    assert.equal(
      reads.workspaces,
      sidebarReads,
      "Archive and Restore leave the sidebar to its live read"
    );
    const beforeLastRestore = reads.archives.length;
    await backend.write("updateWorkspace", { workspaceId: cloud, state: "ready" });
    await until(() => reads.archives.length > beforeLastRestore);
    await group.getByRole("button", { name: "Archived (0)" }).waitFor();
    await group.getByText("No archived workspaces here.").waitFor();
    await open.click();
    await open.waitFor({ state: "detached" });
    assert.equal(await disclosure.count(), 0);
    db.prepare(
      `INSERT INTO workspaces (id, repository_id, slug, kind, organization_id, provider_workspace_id, state)
       VALUES (?, ?, 'no-chat', 'cloud', 'blue', ?, 'archived')`
    ).run(crypto.randomUUID(), project.id, crypto.randomUUID());
    await backend.write("archiveWorkspace", { workspaceId: person.id });
    await disclosure.click();
    await restore(person).waitFor();
    assert.equal(await row(page, person).count(), 0);
    await page.keyboard.press("Control+2");
    const enabledRestore = group.getByRole("button", { name: "Restore no-chat", disabled: false });
    await enabledRestore.click();
    await page
      .locator("[data-sonner-toast] [data-title]", {
        hasText: "The cloud computer exists, but its chat did not open.",
      })
      .waitFor();
    await enabledRestore.waitFor();
  });
}
