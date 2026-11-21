/* global window, document, requestAnimationFrame, DataTransfer, ClipboardEvent */
// Node 22 with --import tsx. Isolated agentless backend, SQLite, Chromium and Vite.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { chromium } from "playwright";
import { createServer } from "vite";
import { startPlatform } from "./cloud/platform.mjs";
import { SCHEMA_SQL } from "../../shared/schema.ts";
import { createStack, freePort, until } from "./remote-access/stack.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const evidence = path.join(root, ".context/composer-drafts");
await mkdir(evidence, { recursive: true });
const directory = await mkdtemp(path.join(evidence, "run-"));
const database = path.join(directory, "deus.db");
const db = new Database(database);
const project = path.join(directory, "project");
await mkdir(project);
const git = (...args) => execFileSync("git", args, { cwd: project, stdio: "pipe" });
git("init", "-b", "main");
git(
  "-c",
  "user.email=test@example.test",
  "-c",
  "user.name=Draft test",
  "commit",
  "--allow-empty",
  "-m",
  "Fixture"
);
db.exec(SCHEMA_SQL);
const repo = crypto.randomUUID();
const chatWorkspace = crypto.randomUUID();
const firstChat = crypto.randomUUID();
const tabsWorkspace = crypto.randomUUID();
const tabsChat = crypto.randomUUID();
const startWorkspace = crypto.randomUUID();
db.prepare(
  "INSERT INTO repositories (id, name, root_path, git_default_branch) VALUES (?, 'Drafts', ?, 'main')"
).run(repo, project);
for (const [workspace, chat, slug] of [
  [chatWorkspace, firstChat, "ready"],
  [tabsWorkspace, tabsChat, "tabs"],
]) {
  db.prepare(
    "INSERT INTO workspaces (id, repository_id, title, slug, state, current_session_id) VALUES (?, ?, ?, ?, 'ready', ?)"
  ).run(workspace, repo, slug, slug, chat);
  db.prepare(
    "INSERT INTO sessions (id, workspace_id, agent_harness, status, message_count) VALUES (?, ?, 'claude-code', 'idle', 1)"
  ).run(chat, workspace);
}
db.prepare(
  "INSERT INTO workspaces (id, repository_id, title, slug, state, git_target_branch, git_source_branch, git_branch) VALUES (?, ?, 'Waiting workspace', 'waiting', 'error', 'main', 'main', 'test/waiting')"
).run(startWorkspace, repo);
await writeFile(
  path.join(directory, "preferences.json"),
  JSON.stringify({ onboarding_completed: true, remote_access_enabled: false })
);
const png = path.join(directory, "screenshot.png");
await writeFile(
  png,
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7xkAAAAASUVORK5CYII=",
    "base64"
  )
);
const stack = createStack({ root, directory });
const failures = [];
async function check(name, test) {
  try {
    await test();
    console.log("PASS", name);
  } catch (error) {
    console.error("FAIL", name, error.message);
    failures.push(name);
  }
}
const main = (page) => page.locator('[data-slot="main-content"]');
const homeInput = (page) => page.getByLabel("Message to start a new workspace");
const chatInput = (page) => main(page).locator("textarea").first();
const preview = (page) => page.getByRole("button", { name: "Preview image screenshot.png" });

// Chromium hit-tests each event. Hold at the center, where Home's overlay text
// appears. A DOM drop targeted at the textarea bypasses this retargeting.
async function dropPicture(page, input, surface) {
  await input.hover();
  const before = await preview(page).count();
  const point = await input.evaluate((el, surface) => {
    const area = surface === "Home" ? el.parentElement.parentElement : el;
    const box = area.getBoundingClientRect();
    return { x: Math.floor(box.x + box.width / 2), y: Math.floor(box.y + box.height / 2) };
  }, surface);
  const cdp = await page.context().newCDPSession(page);
  const drag = (type) =>
    cdp.send("Input.dispatchDragEvent", {
      type,
      ...point,
      data: { items: [], files: [png], dragOperationsMask: 1 },
    });
  try {
    await drag("dragEnter");
    await drag("dragOver");
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, point);
    await drag("drop");
    await until(async () => (await preview(page).count()) === before + 1, 3000).catch(() => {
      throw new Error(`No preview after drop (hit ${hit})`);
    });
  } finally {
    await cdp.detach();
  }
}
let vite, hosted, platform, browser;
try {
  const host = await stack.host({
    name: "composer",
    database,
    dir: directory,
    env: { DEUS_USER_DATA_DIR: directory, TMPDIR: directory },
  });
  vite = await createServer({
    configFile: path.join(root, "apps/web/vite.config.ts"),
    cacheDir: path.join(evidence, "vite-cache"),
    logLevel: "error",
    define: { "import.meta.env.VITE_BACKEND_PORT": JSON.stringify(new URL(host.url).port) },
    server: {
      host: "127.0.0.1",
      port: await freePort(),
      strictPort: true,
      hmr: false,
      fs: { allow: [root] },
    },
  });
  await vite.listen();
  const base = vite.resolvedUrls.local[0] + "s/local";
  browser = await chromium.launch();
  const screen = { viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" };
  const context = await browser.newContext(screen);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.setDefaultNavigationTimeout(90000);
  page.on("pageerror", (e) => console.error("PAGE", e.message));
  const url = (id) => base + "/w/" + id;
  const openHome = async (p = page) => {
    await p
      .getByRole("button", { name: "New workspace in Drafts", exact: true })
      .click({ timeout: 60000 });
    await homeInput(p).waitFor();
  };
  const openWorkspace = (id, p = page) => p.locator(`[data-workspace-id="${id}"]`).first().click();
  const value = (input, text) =>
    until(
      async () => (await input.inputValue({ timeout: 1000 })) === text,
      3500,
      `draft "${text.slice(0, 35)}"`
    );
  const input = chatInput(page);
  const notice = (p, count) =>
    p.getByText(
      count === 1
        ? "1 picture was not kept. Add it again."
        : `${count} pictures were not kept. Add them again.`,
      { exact: true }
    );
  const newTab = () => page.getByRole("button", { name: "New chat tab", exact: true }).click();
  const tabs = page.getByRole("tablist", { name: "Session tabs" }).getByRole("tab");
  const data = [];
  let refusedId,
    refusal,
    sends = 0;
  // Every operation reaches the backend except the send whose acknowledgement is lost.
  await page.routeWebSocket(/\/ws$/, (socket) => {
    const server = socket.connectToServer();
    server.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === "q:mutate_result" && frame.id === refusedId) refusal = frame;
      socket.send(raw);
    });
    socket.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === "q:mutate" && frame.action === "sendMessage") {
        data.push(frame.params);
        if (frame.params.content.includes("Refused draft")) refusedId = frame.id;
        if (frame.params.content === "uncertain send") {
          sends++;
          socket.close({ code: 1011, reason: "Fixture lost the acknowledgement" });
          server.close();
          return;
        }
      }
      server.send(raw);
    });
  });
  const pastePicture = async (input) => {
    await input.evaluate(
      (el, bytes) => {
        const clipboardData = new DataTransfer();
        clipboardData.items.add(
          new File([Uint8Array.from(bytes)], "pasted.png", { type: "image/png" })
        );
        el.dispatchEvent(
          new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData })
        );
      },
      Array.from(await readFile(png))
    );
  };
  await page.goto(url(chatWorkspace));
  await openHome();
  await check("Home file drop", () => dropPicture(page, homeInput(page), "Home"));
  await check("Home draft and picture survive navigation", async () => {
    await homeInput(page).fill("Home draft");
    await openWorkspace(chatWorkspace);
    await input.waitFor();
    await openHome();
    await value(homeInput(page), "Home draft");
    await preview(page).waitFor();
  });
  await check(
    "Home survives reload, explains two missing pictures and dismisses the line",
    async () => {
      await homeInput(page).fill("Still building");
      await dropPicture(page, homeInput(page), "Home");
      await until(async () => (await preview(page).count()) === 2);
      await page.reload();
      await openHome();
      await value(homeInput(page), "Still building");
      await notice(page, 2).waitFor();
      await homeInput(page)
        .locator("../..")
        .screenshot({ path: path.join(evidence, "restored-home.png"), animations: "disabled" });
      assert.equal(await preview(page).count(), 0);
      await page.getByLabel("Dismiss missing pictures").click();
      await notice(page, 2).waitFor({ state: "detached" });
      await page.reload();
      await openHome();
      await value(homeInput(page), "Still building");
      assert.equal(await notice(page, 2).count(), 0);
      const other = await context.newPage();
      try {
        await other.goto(url(chatWorkspace));
        await openHome(other);
        await value(homeInput(other), "");
      } finally {
        await other.close();
      }
    }
  );
  await page.goto(url(chatWorkspace));
  await check("Chat file drop", () => dropPicture(page, input, "Chat"));
  await check(
    "Two chats keep separate drafts and attachments through close and restore",
    async () => {
      await page.goto(url(tabsWorkspace));
      await input.fill("First chat draft");
      const pasted = page.getByRole("button", { name: "Preview image pasted.png" });
      await pastePicture(input);
      await pasted.waitFor();
      await newTab();
      await value(input, "");
      assert.equal(await preview(page).count(), 0);
      await input.fill("Second chat draft");
      await tabs.first().click();
      await value(input, "First chat draft");
      await pasted.waitFor();
      await tabs
        .first()
        .locator("..")
        .getByRole("button", { name: /Close .* tab/ })
        .click();
      await value(input, "Second chat draft");
      await page.getByRole("button", { name: "Restore closed session" }).click();
      await page.getByRole("dialog").getByRole("button").click();
      await value(input, "First chat draft");
      await pasted.waitFor();
    }
  );
  const paste = (text) =>
    input.evaluate((el, text) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", text);
      el.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData })
      );
    }, text);
  await page.goto(url(chatWorkspace));
  await check("A refused send keeps the draft through a reload", async () => {
    await input.fill("Refused draft");
    await input.press("Enter");
    await until(() => refusal?.success === false, 5000, "backend refusal");
    await page.locator("[data-sonner-toast]").first().waitFor();
    await page.reload();
    await value(input, "Refused draft");
  });
  await check("Lost acknowledgement leaves the draft unsent by reconnect or reload", async () => {
    await input.fill("uncertain send");
    await input.press("Enter");
    await until(() => sends === 1);
    await page
      .locator("[data-sonner-toast]")
      .filter({ hasText: /connection|delivery|disconnected/i })
      .first()
      .waitFor();
    await page.reload();
    await value(input, "uncertain send");
    assert.equal(sends, 1);
  });
  await page.goto(url(startWorkspace));
  await check("Start file drop", () => dropPicture(page, input, "Start"));
  await check(
    "Start draft survives reload and adding a picture removes the missing-picture line",
    async () => {
      await input.fill("Start draft");
      await page.reload();
      await value(input, "Start draft");
      await notice(page, 1).waitFor();
      await dropPicture(page, input, "Start");
      await notice(page, 1).waitFor({ state: "detached" });
      await page.getByLabel("Remove attachment").click({ force: true });
    }
  );
  await check(
    "A waiting start explains the follow-up before Send and hands it over once",
    async () => {
      await input.fill("first waiting message");
      await input.press("Enter");
      await page
        .locator('[data-slot="waiting-message"]')
        .getByText("first waiting message")
        .waitFor();
      await input.fill("my follow-up");
      await page
        .getByText("You can send this draft when the chat opens.", { exact: true })
        .waitFor();
      assert.equal(await page.getByLabel("Send message", { exact: true }).isDisabled(), true);
      await input.press("Enter");
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      );
      assert.equal(
        await page
          .getByText("A message is already waiting for this workspace", { exact: true })
          .count(),
        0,
        "Enter showed the old refusal"
      );
      await value(input, "my follow-up");
      await dropPicture(page, input, "Start");
      await page.getByRole("button", { name: "Retry", exact: true }).first().click();
      await page.locator('[data-slot="workspace-start-state"]').waitFor({ state: "detached" });
      await value(input, "first waiting message\n\nmy follow-up");
      await preview(page).waitFor();
      await page.reload();
      await value(input, "first waiting message\n\nmy follow-up");
      assert.equal(data.filter((f) => f.content === "first waiting message").length, 1);
    }
  );
  await check(
    "An over-quota paste stays in memory and smaller saved drafts still reload",
    async () => {
      await page.goto(url(chatWorkspace));
      await openHome();
      await homeInput(page).fill("A smaller saved draft");
      await openWorkspace(chatWorkspace);
      const errors = [];
      const collectError = (error) => errors.push(error.message);
      page.on("pageerror", collectError);
      await page.evaluate(() => {
        window.quotaFailures = 0;
        const write = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          try {
            return write.call(this, key, value);
          } catch (error) {
            if (key.startsWith("composer-drafts:") && error.name === "QuotaExceededError")
              window.quotaFailures++;
            throw error;
          }
        };
      });
      const largePaste = "A line of the oversized paste.\n".repeat(210000);
      await paste(largePaste);
      await page
        .getByText(/^A line of the oversized paste/)
        .first()
        .waitFor();
      await openHome();
      await value(homeInput(page), "A smaller saved draft");
      const initialFailures = await page.evaluate(() => {
        window.keyTimes = [];
        let start;
        document.addEventListener(
          "input",
          () => {
            start = performance.now();
          },
          true
        );
        document.addEventListener("input", () => window.keyTimes.push(performance.now() - start));
        return window.quotaFailures;
      });
      const letters = "x".repeat(24);
      await homeInput(page).pressSequentially(letters);
      const edited = await homeInput(page).inputValue();
      assert(edited.includes(letters));
      const [times, retries] = await page.evaluate(
        (initial) => [window.keyTimes, window.quotaFailures - initial],
        initialFailures
      );
      times.sort((a, b) => a - b);
      assert.equal(times.length, letters.length);
      const median = (times[times.length / 2 - 1] + times[times.length / 2]) / 2;
      const p95 = times[Math.ceil(times.length * 0.95) - 1];
      console.log(
        `TRACE 6.51 MB in chat, ${times.length} Home keystrokes: input handler median ${median.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, max ${times.at(-1).toFixed(2)} ms, ${retries} renewed quota failures`
      );

      await openWorkspace(chatWorkspace);
      await input.waitFor();
      const length = await page.evaluate(async (id) => {
        const { useSessionComposerStore } =
          await import("/src/features/session/store/sessionComposerStore.ts");
        return useSessionComposerStore.getState().composers[id].pastedTexts.at(-1).content.length;
      }, firstChat);
      assert.equal(length, largePaste.length);
      assert((await page.evaluate(() => window.quotaFailures)) > 0);
      assert.deepEqual(errors, []);
      page.off("pageerror", collectError);
      await page.reload();
      await openHome();
      await value(homeInput(page), edited);
      assert.equal(retries, 0, "An unchanged oversized draft was retried");
    }
  );
  const launchDesktop = async () => {
    const desktop = await chromium.launchPersistentContext(
      path.join(directory, "desktop-profile"),
      { ...screen, headless: true }
    );
    await desktop.addInitScript(() => {
      const reply = Promise.withResolvers();
      const listeners = new Set();
      let session;
      window.answerCloud = (accountId) => {
        const wasAnswered = !!session;
        session = {
          signedIn: !!accountId,
          accountId,
          cloudUrl: "http://localhost",
          expiresAt: null,
          tokenType: accountId ? "Bearer" : null,
          hasPlatformKey: false,
        };
        if (wasAnswered) listeners.forEach((listener) => listener(session));
        else reply.resolve(session);
      };
      const subscribe = () => () => {};
      window.electronAPI = {
        getDeusCloudSession: () => session ?? reply.promise,
        onDeusCloudAuthChanged: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        invoke: async () => {},
        on: subscribe,
        isFullscreen: async () => false,
        onFullscreenChange: subscribe,
        getUpdateState: async () => ({ stage: "idle" }),
        onUpdateState: subscribe,
      };
    });
    const p = await desktop.newPage();
    p.on("pageerror", (error) => console.error("DESKTOP", error.message));
    p.setDefaultTimeout(8000);
    p.setDefaultNavigationTimeout(90000);
    return { desktop, p };
  };
  const answerCloud = async (p, accountId = "desktop-account") => {
    await p.evaluate((id) => window.answerCloud(id), accountId);
    await p.waitForFunction(async (id) => {
      const { queryClient } = await import("/src/shared/api/queryClient.ts");
      const { queryKeys } = await import("/src/shared/api/queryKeys.ts");
      return queryClient.getQueryData(queryKeys.deusCloud.session)?.accountId === id;
    }, accountId);
  };
  let single = await launchDesktop();
  try {
    let p = single.p;
    await p.goto(base);
    await openWorkspace(chatWorkspace, p);
    assert(await p.locator("html.electron").count(), "Desktop CSS is active");
    assert.deepEqual(
      await p.evaluate(async () => {
        const { getRuntimeClient } = await import("/src/platform/ws/query-protocol-client.ts");
        const { host, account } = getRuntimeClient().identity;
        return [host, account];
      }),
      ["electron", "electron"]
    );
    await check("Desktop CSS chat file drop", () => dropPicture(p, chatInput(p), "Chat"));
    const failed = await host.write("createWorkspace", {
      repository_id: repo,
      source_branch: "no-such-branch",
    });
    await openWorkspace(failed.workspaceId, p);
    await p.locator('[data-slot="workspace-start-state"][data-state="failed"]').waitFor();
    await check("Desktop CSS start file drop", () => dropPicture(p, chatInput(p), "Start"));
    await openHome(p);
    await check("Desktop CSS Home file drop", () => dropPicture(p, homeInput(p), "Home"));
    await homeInput(p).fill("Typed before the cloud answered");
    await answerCloud(p);
    await openWorkspace(chatWorkspace, p);
    await chatInput(p).fill("Typed after the cloud answered");
    await check(
      "Desktop keeps both drafts when the cloud account arrives after first paint",
      async () => {
        await openHome(p);
        await value(homeInput(p), "Typed before the cloud answered");
        await openWorkspace(chatWorkspace, p);
        await value(chatInput(p), "Typed after the cloud answered");
      }
    );
    await single.desktop.close();
    single = await launchDesktop();
    p = single.p;
    await p.goto(base);
    await check(
      "Desktop relaunch restores both drafts before the cloud account answers and through sign-out",
      async () => {
        for (const account of [undefined, "desktop-account", null]) {
          if (account !== undefined) await answerCloud(p, account);
          await openHome(p);
          await value(homeInput(p), "Typed before the cloud answered");
          await notice(p, 1).waitFor();
          await openWorkspace(chatWorkspace, p);
          await value(chatInput(p), "Typed after the cloud answered");
        }
      }
    );
  } finally {
    await single.desktop.close();
  }
  const bearer =
    "test." + Buffer.from(JSON.stringify({ sub: "account-a" })).toString("base64url") + ".test";
  let hostedSessions = ["Cloud chat"];
  platform = await startPlatform({
    bearer,
    org: "org-drafts",
    sessions: [],
    listSessions: () =>
      hostedSessions.map((title, i) => ({
        id: "hosted-" + i,
        status: "idle",
        workspace_id: "workspace-" + i,
        workspace_status: "running",
        sandbox_id: "sandbox-" + i,
        title,
        repo: "test/drafts",
        branch: "main",
        harness: "claude-code",
        created_at: new Date(0).toISOString(),
        updated_at: new Date(0).toISOString(),
      })),
  });
  const hostedPort = await freePort();
  const origin = "http://127.0.0.1:" + hostedPort;
  hosted = await createServer({
    configFile: path.join(root, "apps/web/vite.config.ts"),
    cacheDir: path.join(evidence, "vite-hosted"),
    logLevel: "error",
    define: {
      "import.meta.env.VITE_CLOUD_DIRECT": JSON.stringify("1"),
      "import.meta.env.VITE_BACKEND_PORT": JSON.stringify(""),
      "import.meta.env.VITE_DEUS_CLOUD_URL": JSON.stringify(platform.url),
      "import.meta.env.VITE_AGNT_BASE_URL": JSON.stringify(platform.url),
    },
    server: {
      host: "127.0.0.1",
      port: hostedPort,
      strictPort: true,
      hmr: false,
      fs: { allow: [root] },
    },
  });
  await hosted.listen();
  await check("Hosted Home describes its actual discovery refresh", async () => {
    const cloudPage = await context.newPage();
    await cloudPage.addInitScript(
      (token) => sessionStorage.setItem("deus_cloud_session", token),
      bearer
    );
    await cloudPage.clock.install();
    try {
      await cloudPage.goto(origin, { timeout: 90000 });
      await cloudPage.getByText("Cloud chat", { exact: true }).first().waitFor();
      hostedSessions = [...hostedSessions, "Created after refresh"];
      // The clock owns the visible tab's real 60-second discovery interval.
      assert.equal(await cloudPage.getByText("Created after refresh", { exact: true }).count(), 0);
      await cloudPage.clock.fastForward(60001);
      await cloudPage.getByText("Created after refresh", { exact: true }).first().waitFor();
      await cloudPage
        .getByText(
          "Start a session in the Deus desktop app. This list refreshes every minute and when you return to this tab.",
          { exact: true }
        )
        .waitFor({ timeout: 3000 });
    } finally {
      await cloudPage.close();
    }
  });
  assert.deepEqual(failures, []);
} finally {
  await browser?.close();
  await hosted?.close();
  await platform?.close();
  await vite?.close();
  await stack.close();
  db.close();
}
