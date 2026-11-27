/* global window, document, getComputedStyle, requestAnimationFrame */
// A person creates a local coordinator on Home. The engine’s scripted harness calls its actual host tools.
import assert from "node:assert/strict";
import { execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, open, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openBoardReport } from "./lib/board-file.mjs";
import { checkPhoneChatFile, reportReply } from "./lib/chat-file-link.mjs";
import { installScriptedChat } from "./lib/scripted-chat.mjs";
import Database from "better-sqlite3";
import { chromium } from "playwright";
import { createServer } from "vite";
import { SCHEMA_SQL } from "../../shared/schema.ts";
import { LOOPBACK_WEB_ORIGINS } from "../../shared/web-origins.ts";
import { DEUS_TOOLS_SERVER } from "../../shared/mcp-servers.ts";
import { connectBackend } from "./lib/operations.mjs";
import { freePort, until } from "./remote-access/stack.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const prompt = "Open the release board";
const question = "Who should review the checklist?";
const answer = "@you The release captain can review it today.";
const reportTitle = "Phone verification results";
const planPrompt = "Read the release board in Plan mode";
const handoff = "Can the coordinator take the handoff?";
const historySize = 82; // Two full pages and a partial oldest page.

async function fixtureMessage(child, timeout, send) {
  if (child.exitCode !== null || child.signalCode !== null)
    throw new Error(`Board fixture exited (${child.signalCode ?? child.exitCode})`);
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]);
  try {
    const received = Promise.race([
      once(child, "message", { signal }),
      once(child, "exit", { signal }).then(([code, signal]) => {
        throw new Error(`Board fixture exited (${signal ?? code})`);
      }),
    ]);
    const [[message]] = await Promise.all([received, Promise.resolve().then(send)]);
    return message;
  } finally {
    controller.abort();
  }
}

async function backendProcess() {
  const release = Promise.withResolvers();
  const startPosts = Promise.withResolvers();
  const finishPlan = Promise.withResolvers();
  process.on("message", (command) => {
    if (command?.workspace) startPosts.resolve(command);
    if (command === "release") release.resolve();
    if (command === "finish-plan") finishPlan.resolve();
  });
  const call = (tool, args) => ({ call: { server: DEUS_TOOLS_SERVER, tool, arguments: args } });
  async function* turn({ input }) {
    if (input === prompt) {
      yield call("create_board", { name: "Release desk" });
      const { own } = await startPosts.promise;
      yield call("post_to_board", {
        workspace: own,
        body: "Release checklist\n\nThe build is ready for review.",
      });
      await release.promise;
      yield { say: "The release checklist is ready.\n\n" + reportReply };
    } else if (typeof input === "string" && input.endsWith(question)) {
      const { workspace } = await startPosts.promise;
      const sessions = yield call("list_sessions", {});
      assert.ok(sessions.output.includes(workspace));
      yield call("post_to_board", {
        body:
          answer +
          "\n\n[report.md](.context/report.md) · [outside](../outside.md) · [moved](moved.md) · [linked](linked.md)",
        workspace,
      });
    } else if (input === "Publish the checklist history") {
      for (let i = 1; i <= historySize; i++)
        yield call("post_to_board", { body: "Checklist item " + i });
    } else if (input === "Publish the latest update") {
      yield call("post_to_board", {
        body: "Final checklist update\n\n" + "- Check passed.\n".repeat(12),
      });
    } else if (input === "Start the handoff chat") {
      const { own } = await startPosts.promise;
      yield call("start_session", {
        project: "Workbench",
        workspace: own,
        agent: "claude-code",
        model: "sonnet",
        message: "Open the handoff board",
      });
    } else if (typeof input === "string" && input.endsWith("Open the handoff board")) {
      yield call("create_board", { name: "Release handoff" });
    } else if (typeof input === "string" && input.startsWith("Archive chat ")) {
      yield call("archive", { sessions: [input.slice("Archive chat ".length)] });
    } else if (input === planPrompt) {
      const read = yield call("read_board", {});
      assert.match(read.output, /Release checklist/);
      const write = yield call("post_to_board", { body: "A read-only turn cannot publish this." });
      assert.match(write.error, /refused \(read_only\)/);
      process.send("read-in-plan");
      await finishPlan.promise;
    } else if (typeof input === "string" && input.endsWith(handoff)) {
      yield call("post_to_board", { body: "The handoff is ready." });
    }
    yield { end: true };
  }
  await installScriptedChat(turn);
  const { getServerPort } = await import("../../apps/backend/src/server.ts");
  const { isConnected } = await import("../../apps/backend/src/services/agent/index.ts");
  await until(() => getServerPort() && isConnected(), 45000, "the scripted engine");
  process.send(getServerPort());
}

function desktopBridge() {
  const listen = () => () => {};
  window.electronAPI = {
    getDeusCloudSession: async () => ({ signedIn: false }),
    onDeusCloudAuthChanged: listen,
    getUpdateState: async () => ({ stage: "idle" }),
    onUpdateState: listen,
    isFullscreen: async () => false,
    onFullscreenChange: listen,
    on: listen,
    invoke: async () => null,
    getAppVersion: async () => "test",
  };
}

async function checkComposerFocus(textarea) {
  const ring = () =>
    textarea.evaluate((el) =>
      getComputedStyle(el.closest("[data-slot=input-group]")).getPropertyValue("--tw-ring-shadow")
    );
  await textarea.evaluate((el) => el.blur());
  const resting = await ring();
  await textarea.focus();
  // The composer is the page's focus; its caret is its focus state, so the surface does not change.
  assert.equal(await ring(), resting, "Focusing the composer leaves its surface unchanged");
}

async function run() {
  const parent = process.env.DEUS_BOARD_LAB_ROOT ?? tmpdir();
  await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(path.join(parent, "board-"));
  const repo = path.join(dir, "project");
  await mkdir(repo);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.name=Deus",
    "-c",
    "user.email=test@localhost",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "Start",
  ]);
  const database = path.join(dir, "deus.db");
  const db = new Database(database);
  db.exec(SCHEMA_SQL);
  db.prepare(
    "INSERT INTO repositories (id,name,root_path,git_default_branch) VALUES ('project','Workbench',?,'main')"
  ).run(repo);
  db.exec(
    "INSERT INTO repositories (id,name,git_origin_url) VALUES ('hosted','Hosted project','https://github.com/example/hosted.git')"
  );
  db.close();
  await writeFile(
    path.join(dir, "preferences.json"),
    JSON.stringify({ onboarding_completed: true, remote_access_enabled: false, chat_view: "full" })
  );
  const log = await open(path.join(dir, "backend.log"), "w");
  const child = fork(new URL(import.meta.url), [], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", log.fd, log.fd, "ipc"],
    env: {
      ...process.env,
      PORT: "0",
      DATABASE_PATH: database,
      DEUS_USER_DATA_DIR: dir,
      DEUS_VAULT_NO_KEYCHAIN: "1",
      DEUS_WEB_ORIGINS: LOOPBACK_WEB_ORIGINS,
      DEUS_GITHUB_API_URL: "http://127.0.0.1:1",
      GIT_CEILING_DIRECTORIES: dir,
      AGENT_ALLOW_AGENTLESS: "0",
      TSX_TSCONFIG_PATH: path.join(root, "apps/backend/tsconfig.json"),
    },
  });
  let host, vite, browser;
  let passed = false;
  try {
    const port = await fixtureMessage(child, 45000);
    host = await connectBackend("http://127.0.0.1:" + port);
    vite = await createServer({
      configFile: path.join(root, "apps/web/vite.config.ts"),
      logLevel: "error",
      cacheDir: path.join(root, ".context/board-vite"),
      define: { "import.meta.env.VITE_BACKEND_PORT": JSON.stringify(String(port)) },
      server: {
        host: "127.0.0.1",
        port: await freePort(),
        strictPort: true,
        hmr: false,
        fs: { allow: [root] },
      },
    });
    await vite.listen();
    const base = vite.resolvedUrls.local[0];
    browser = await chromium.launch({ headless: true });
    const desktop = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: "dark",
    });
    await desktop.addInitScript(desktopBridge);
    const page = await desktop.newPage();
    page.setDefaultTimeout(18000);
    await page.goto(base);
    const flag = page.getByRole("button", { name: "Coordinator", exact: true });
    await flag.waitFor();
    for (const name of ["Start new project", "Clone from GitHub", "Open local project"])
      await page.getByRole("button", { name, exact: true }).waitFor();
    assert.equal(await page.locator("section[aria-label$=' workspaces']").count(), 0);
    assert.equal(await flag.getAttribute("aria-pressed"), "false");
    const openHomeFor = (repoId) =>
      page.evaluate(async (id) => {
        const { openNewWorkspace } = await import("/src/features/workspace/lib/newWorkspace.ts");
        openNewWorkspace({ repoId: id });
      }, repoId);
    await openHomeFor("hosted");
    await until(() => flag.isDisabled(), 5000, "cloud coordinator control");
    assert.equal(await flag.getAttribute("aria-pressed"), "false");
    await flag.locator("..").focus();
    await page
      .getByRole("tooltip")
      .filter({ hasText: "Coordinators run on this computer" })
      .waitFor();
    await openHomeFor("project");
    await until(() => flag.isEnabled(), 5000, "local coordinator control");
    await flag.hover();
    const description =
      "A coordinator starts and directs work in other workspaces and reports to you on a board.";
    await page.getByRole("tooltip").filter({ hasText: description }).waitFor();
    await flag.click();
    await flag.getByText("Coordinator", { exact: true }).waitFor();
    await page.locator("p").filter({ hasText: description }).waitFor();
    assert.equal(await flag.getAttribute("aria-pressed"), "true");
    if (process.env.DEUS_BOARD_SCREENSHOTS) {
      await page.waitForFunction(
        (button) => {
          for (let el = button; el; el = el.parentElement)
            if (Number(getComputedStyle(el).opacity) < 0.99) return false;
          return true;
        },
        await page.getByRole("button", { name: "Start new project", exact: true }).elementHandle()
      );
      await page.mouse.move(2, 2);
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(
          document
            .getAnimations()
            .filter((a) => a.effect?.getTiming().iterations !== Infinity)
            .map((a) => a.finished.catch(() => {}))
        );
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      await page.screenshot({
        path: path.join(process.env.DEUS_BOARD_SCREENSHOTS, "coordinator-home.png"),
        animations: "disabled",
        style: ".tsqd-parent-container{visibility:hidden!important}",
      });
    }
    const home = page.getByRole("textbox", { name: "Message to start a new workspace" });
    await home.fill(prompt);
    await home.press("Enter");
    const boardRow = page.getByRole("button", { name: "release-desk" });
    await boardRow.click();
    const [board] = await host.read("boards");
    const sid = board.delivery_session_id;
    await host.write("updateSessionTitle", { sessionId: sid, title: "Release room" });
    const workspace = await host.read("workspace", { workspaceId: board.workspace_id });
    await mkdir(path.join(workspace.workspace_path, ".context"), { recursive: true });
    await writeFile(
      path.join(workspace.workspace_path, ".context/report.md"),
      "# Release verification\n"
    );
    assert.equal(workspace.role, "coordinator");
    assert.equal(new URL(page.url()).pathname, "/b/" + board.id);
    await page.reload();
    const feed = page.getByRole("region", { name: "Channel messages" });
    await feed
      .getByText("No posts yet. The coordinator posts here when it starts or finishes work.")
      .waitFor();
    assert.equal(await page.getByRole("button", { name: /^\d+ workspaces?$/ }).count(), 0);
    const mobileWorkspace = await host.write("createWorkspace", { repository_id: "project" });
    await until(
      async () => {
        const w = await host.read("workspace", { workspaceId: mobileWorkspace.workspaceId });
        return w.state === "ready";
      },
      20000,
      "reply subject workspace"
    );
    const subject = await host.read("workspace", { workspaceId: mobileWorkspace.workspaceId });
    await host.write("updateWorkspaceTitle", {
      workspaceId: subject.id,
      title: "Mobile verification",
    });
    await mkdir(path.join(subject.workspace_path, ".context"), { recursive: true });
    await writeFile(
      path.join(subject.workspace_path, ".context/report.md"),
      "# " + reportTitle + "\n"
    );
    await writeFile(path.join(dir, "outside.md"), "Outside this workspace");
    await symlink(path.join(dir, "outside.md"), path.join(subject.workspace_path, "linked.md"));
    child.send({ workspace: subject.slug, own: workspace.slug });
    const rootRow = feed.locator("article[data-seq='1']");
    await rootRow.getByText("Coordinator", { exact: true }).waitFor();
    const place = workspace.title ?? workspace.slug;
    await page.getByRole("link", { name: "Open workspace, " + place }).waitFor();
    assert.equal(await rootRow.getByRole("link").count(), 0);
    assert.equal(await page.getByRole("button", { name: /^\d+ workspaces?$/ }).count(), 0);
    await feed.getByText("Today", { exact: true }).waitFor();
    const channelWidth = () =>
      page
        .locator("main")
        .filter({ has: feed })
        .last()
        .evaluate((el) => Math.round(el.getBoundingClientRect().width));
    assert.equal(await channelWidth(), 880);
    const boardType = await rootRow
      .locator(".markdown-content p")
      .first()
      .evaluate((el) => [getComputedStyle(el).fontSize, getComputedStyle(el).lineHeight]);
    await rootRow.hover();
    await rootRow.getByRole("button", { name: "Reply in thread" }).click();
    const thread = page.getByRole("complementary", { name: "Thread" });
    const reply = thread.getByRole("textbox", { name: "Reply…" });
    await checkComposerFocus(reply);
    const divider = page.getByRole("separator").and(page.locator("[data-slot=resizable-handle]"));
    await divider.waitFor({ state: "attached" });
    assert.equal(Number(await divider.getAttribute("aria-valuenow")), 55);
    await divider.focus();
    await page.keyboard.press("ArrowLeft");
    await until(
      async () => Number(await divider.getAttribute("aria-valuenow")) < 55,
      4000,
      "workspace keyboard resize"
    );
    const keyboardWidth = Number(await divider.getAttribute("aria-valuenow"));
    const handle = await divider.boundingBox();
    const y = handle.y + handle.height / 2;
    await page.mouse.move(handle.x, y);
    await page.mouse.down();
    await page.mouse.move(handle.x + 38, y, { steps: 5 });
    await page.mouse.up();
    const savedWidth = Number(await divider.getAttribute("aria-valuenow"));
    assert.ok(savedWidth > keyboardWidth);
    await reply.fill(question);
    await reply.press("Enter");
    await thread.getByRole("link", { name: "Queued for Coordinator · Release room" }).waitFor();
    // Losing a queued send leaves the board copy. Only the person's explicit retry delivers it.
    assert.equal(
      await thread.locator("article[data-seq='2'] [data-slot=avatar].rounded-full").count(),
      1
    );
    assert.equal(await thread.locator("article[data-seq='1'] [data-board-avatar=bot]").count(), 1);
    assert.equal(await thread.getByRole("status").locator("[data-board-avatar=bot]").count(), 1);
    const queued = (await host.read("queuedMessages", { sessionId: sid })).items[0];
    await host.write("removeQueuedMessage", { sessionId: sid, id: queued.id });
    await thread.getByRole("status").filter({ hasText: "Not delivered:" }).waitFor();
    await thread.getByRole("button", { name: "Send again" }).click();
    await thread.getByRole("link", { name: "Queued for Coordinator · Release room" }).waitFor();
    child.send("release");
    await thread.getByRole("link", { name: "Sent to Coordinator · Release room" }).waitFor();
    await thread.getByText(/The release captain can review it today/).waitFor();
    await thread.locator("span.rounded-full").filter({ hasText: /^@/ }).waitFor();
    const subjectChip = thread
      .locator("article[data-seq='3']")
      .getByRole("link", { name: "Open workspace, Mobile verification" });
    assert.ok((await subjectChip.getAttribute("href")).includes(subject.id));
    const desktopFile = await openBoardReport(page, "Mobile verification", reportTitle);
    await desktopFile.getByRole("button", { name: "Open in workspace" }).click();
    await page.getByRole("heading", { name: reportTitle, exact: true }).waitFor();
    assert.equal(await desktopFile.count(), 0);
    await page.goto(base + "b/" + board.id + "?thread=1");
    const outside = thread.getByRole("button", { name: "outside.md .." });
    assert.ok(await outside.isDisabled());
    await thread.getByRole("button", { name: "linked.md" }).click();
    await desktopFile.getByText("Invalid file path", { exact: true }).waitFor();
    await desktopFile.getByRole("button", { name: "Close", exact: true }).click();
    await thread.getByRole("button", { name: "moved.md" }).click();
    await desktopFile.getByText("This file isn't in Mobile verification any more.").waitFor();
    await desktopFile.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "1 workspace", exact: true }).click();
    const workspaces = page.getByRole("menu", { name: "1 workspace" });
    await workspaces.getByRole("menuitem", { name: "Mobile verification" }).click();
    await until(
      () =>
        page.evaluate(async (id) => {
          const { useWorkspaceStore } = await import("/src/features/workspace/store/index.ts");
          return useWorkspaceStore.getState().selectedWorkspaceId === id;
        }, subject.id),
      5000,
      "open the named workspace"
    );
    await page.goto(base + "b/" + board.id + "?thread=1");
    assert.equal(
      (await host.read("boardThread", { boardId: board.id, thread: 1 })).replies.length,
      2
    );
    assert.equal(Number(await divider.getAttribute("aria-valuenow")), savedWidth);
    await thread.getByRole("link", { name: "Sent to Coordinator · Release room" }).click();
    const chatType = await page
      .getByText("The release checklist is ready.", { exact: true })
      .first()
      .evaluate((el) => [getComputedStyle(el).fontSize, getComputedStyle(el).lineHeight]);
    assert.deepEqual(boardType, chatType);
    await page.getByRole("log").getByRole("link", { name: "Read the release report" }).click();
    await page.getByRole("heading", { name: "Release verification", exact: true }).waitFor();
    assert.equal(await desktopFile.count(), 0);
    await page
      .getByText(/From #release-desk · thread 1/)
      .first()
      .waitFor();
    const card = page.getByRole("link", { name: "Open #release-desk" });
    const chatBox = page.locator('[data-slot="main-content"] textarea').first();
    await checkComposerFocus(chatBox);
    const sendChat = async (text) => {
      await chatBox.fill(text);
      await chatBox.press("Enter");
    };

    // The chat can work in Plan, but a delivery needs a turn that can answer the person.
    const idle = () =>
      until(async () => (await host.read("session", { sessionId: sid })).status === "idle");
    const publish = (content) =>
      host.write("sendMessage", {
        sessionId: sid,
        turnId: crypto.randomUUID(),
        content,
        agentHarness: "claude-code",
        model: "sonnet",
        permissionMode: "bypass_permissions",
      });
    await idle();
    const outcome = await fixtureMessage(child, 18000, () => sendChat("/plan " + planPrompt));
    assert.equal(outcome, "read-in-plan");
    await card.click();
    const channel = page.getByRole("textbox", { name: "Message #release-desk" });
    await channel.fill(handoff);
    await channel.press("Enter");
    const refused = feed.locator("article[data-seq]").filter({ hasText: handoff });
    await refused.getByText(/Turn Plan off there with \/plan.*then choose Send again/).waitFor();
    assert.equal((await host.read("queuedMessages", { sessionId: sid })).items.length, 0);
    child.send("finish-plan");
    await idle();
    await rootRow.getByRole("button", { name: "2 replies" }).click();
    await thread.getByRole("link", { name: "Sent to Coordinator · Release room" }).click();
    const planChip = page.getByRole("button", { name: "Exit plan mode", exact: true });
    await planChip.waitFor();
    await sendChat("/plan");
    await planChip.waitFor({ state: "hidden" });
    await sendChat("Resume full access");
    await page.getByText("Resume full access", { exact: true }).first().waitFor();
    await idle();
    await card.click();
    await refused.getByRole("button", { name: "Send again" }).click();
    await refused.getByRole("link", { name: "Sent to Coordinator · Release room" }).waitFor();
    await refused.getByRole("button", { name: /1 reply/ }).click();
    await thread.getByText("The handoff is ready.", { exact: true }).waitFor();

    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const phone = await mobile.newPage();
    await phone.goto(base + "s/local/w/" + workspace.id + "?session=" + sid);
    await checkPhoneChatFile(phone);
    await phone.goto(base + "b/" + board.id + "?thread=1");
    await phone
      .getByRole("complementary", { name: "Thread" })
      .getByText(/release captain/)
      .waitFor();
    const phoneFile = await openBoardReport(phone, "Mobile verification", reportTitle);
    await phone.goBack();
    await phoneFile.waitFor({ state: "detached" });
    await phone.goForward();
    await phoneFile.getByRole("button", { name: "Open in workspace" }).click();
    await phone.waitForURL(
      (url) => url.pathname.endsWith("/w/" + subject.id) && url.searchParams.has("session")
    );
    await phoneFile.getByRole("heading", { name: reportTitle, exact: true }).waitFor();
    assert.equal(await phoneFile.getByRole("button", { name: "Open in workspace" }).count(), 0);
    await phone.goBack();
    await phoneFile.waitFor({ state: "detached" });
    assert.ok(new URL(phone.url()).pathname.endsWith("/w/" + subject.id));
    await phone.goto(base + "b/" + board.id + "?thread=1");
    await host.write("archiveWorkspace", { workspaceId: subject.id });
    await page.goto(base + "b/" + board.id + "?thread=1");
    for (const client of [page, phone]) {
      await openBoardReport(client, "Mobile verification", reportTitle, true);
      await client.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
    }
    await rename(subject.workspace_path, subject.workspace_path + "-away");
    await phone
      .getByRole("complementary", { name: "Thread" })
      .getByRole("button", { name: "report.md .context", exact: true })
      .click();
    await phoneFile.getByText("Mobile verification's files are gone.").waitFor();
    assert.equal(await phoneFile.getByRole("button", { name: "Restore workspace" }).count(), 0);
    await phone.goBack();
    await phoneFile.waitFor({ state: "detached" });
    await rename(subject.workspace_path + "-away", subject.workspace_path);
    await openBoardReport(page, "Mobile verification", reportTitle, true);
    await desktopFile.getByRole("button", { name: "Restore workspace" }).click();
    await desktopFile.getByRole("button", { name: "Open in workspace" }).waitFor();
    await desktopFile.getByRole("button", { name: "Close", exact: true }).click();
    assert.match(phone.url(), /\/s\/local\/b\/[^?]+\?thread=1/);
    await phone.getByRole("button", { name: "Back to channel" }).click();
    await phone.getByRole("button", { name: /2 replies/ }).click();
    await phone.getByRole("complementary", { name: "Thread" }).waitFor();
    await phone.goBack();
    await phone.getByRole("region", { name: "Channel messages" }).waitFor();
    // This phone has never selected a workspace in the fixture's cloud organization.
    await phone.evaluate(async () => {
      const { queryClient } = await import("/src/shared/api/queryClient.ts");
      queryClient.setQueryData(["cloudOrganizations"], {
        available: true,
        accountId: "fixture",
        defaultOrganizationId: "release",
        items: [{ id: "release", name: "Release team", role: "owner", ready: true }],
      });
    });
    await phone.getByRole("button", { name: "Toggle Sidebar", exact: true }).click();
    await phone.getByRole("button", { name: /switch where workspaces run/ }).click();
    await phone.getByRole("menuitem", { name: /Release team/ }).click();
    await phone.waitForURL((url) => url.pathname.replace(/\/$/, "") === "/s/local");
    await phone.locator("[aria-label='Channel messages']").waitFor({ state: "detached" });

    await page.setViewportSize({ width: 1024, height: 900 });
    await page.getByRole("button", { name: "Back to channel" }).waitFor();
    assert.equal(await page.getByRole("region", { name: "Channel messages" }).count(), 0);
    assert.equal(await page.locator("[aria-label='Channel messages']").count(), 1);
    await page.setViewportSize({ width: 1440, height: 900 });
    await mobile.close();
    await page.getByRole("button", { name: "Close thread" }).click();
    await publish("Publish the checklist history");
    await feed.getByText(`Checklist item ${historySize}`, { exact: true }).waitFor();
    await idle();
    await page.reload();
    await feed.getByText(`Checklist item ${historySize}`, { exact: true }).waitFor();
    assert.equal(await feed.locator("article[data-seq]").count(), 40);
    await feed.getByRole("button", { name: "Load earlier" }).click();
    await feed.getByText("Checklist item 40", { exact: true }).waitFor();
    assert.deepEqual(
      await feed.evaluate(async (el) => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return [el.scrollHeight > el.clientHeight, el.scrollTop];
      }),
      [true, 0],
      "The reader stays at the start of a full page of earlier posts"
    );
    await feed.getByRole("button", { name: "Load earlier" }).click();
    await feed.getByText("Release checklist", { exact: true }).waitFor();
    await feed.getByRole("button", { name: "Back to latest" }).click();
    await feed.getByText(`Checklist item ${historySize}`, { exact: true }).waitFor();
    // Let the initial scroll settle before appending a taller root to an already full page.
    await feed.evaluate(async () => {
      for (let frame = 0; frame < 15; frame++) await new Promise(requestAnimationFrame);
    });
    await publish("Publish the latest update");
    await feed.getByText("Final checklist update", { exact: true }).waitFor();
    await until(
      () => feed.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop <= 1),
      5000,
      "follow the latest post after the forty-row page fills"
    );
    await boardRow.locator("[aria-label='Unread posts']").waitFor({ state: "detached" });

    await idle();
    await host.write("archiveWorkspace", { workspaceId: board.workspace_id });
    await boardRow.waitFor({ state: "hidden" });
    await page.reload();
    await page.getByText("The coordinator workspace is archived.", { exact: true }).waitFor();
    await feed.getByText("Final checklist update", { exact: true }).waitFor();
    assert.equal(await page.getByRole("form", { name: "Channel message" }).count(), 0);
    await host.write("updateWorkspace", { workspaceId: board.workspace_id, state: "ready" });
    await boardRow.waitFor();
    // The agent may archive a chat it started. Its board then delivers to the newest open chat.
    await publish("Start the handoff chat");
    await page.getByRole("button", { name: "release-handoff" }).click();
    const handoffBoard = (await host.read("boards")).find((b) => b.name === "Release handoff");
    const original = handoffBoard.delivery_session_id;
    await idle();
    const replacement = await host.write("createSession", { workspaceId: board.workspace_id });
    await host.write("updateSessionTitle", {
      sessionId: replacement.id,
      title: "Release follow-up",
    });
    await publish(`Archive chat ${original}`);
    await until(
      async () => (await host.read("session", { sessionId: original })).is_hidden,
      10000,
      "the agent archiving its board's original chat"
    );
    const handoffChannel = page.getByRole("textbox", { name: "Message #release-handoff" });
    await handoffChannel.fill(handoff);
    await handoffChannel.press("Enter");
    const switched = feed.getByRole("link", { name: "Sent to Coordinator · Release follow-up" });
    await switched.waitFor();
    assert.ok((await switched.getAttribute("href")).includes(replacement.id));
    const switchedBoard = (await host.read("boards")).find((b) => b.id === handoffBoard.id);
    assert.equal(switchedBoard.delivery_session_id, replacement.id);
    await switched
      .locator("xpath=ancestor::article")
      .getByRole("button", { name: "1 reply" })
      .click();
    await thread.getByText("The handoff is ready.", { exact: true }).waitFor();

    const ordinary = await host.write("createWorkspace", { repository_id: "project" });
    const info = () => host.read("workspace", { workspaceId: ordinary.workspaceId });
    await until(async () => (await info()).state === "ready", 20000, "ordinary workspace");
    const before = await info();
    await host.write("sendMessage", {
      sessionId: before.current_session_id,
      turnId: crypto.randomUUID(),
      content: "Read the project",
      agentHarness: "claude-code",
      model: "sonnet",
      permissionMode: "bypass_permissions",
    });
    await until(
      async () =>
        (await host.read("messages", { sessionId: before.current_session_id })).turns.some(
          (t) => t.endedAt
        ),
      10000,
      "ordinary chat's first turn"
    );
    const ordinaryRow = page
      .locator("[data-sidebar-row]")
      .filter({ has: page.getByText(before.slug, { exact: true }) })
      .first();
    await ordinaryRow.click();
    await ordinaryRow.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Make coordinator" }).click();
    await page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "Now a coordinator. New chats here get its tools." })
      .getByRole("button", { name: "New chat", exact: true })
      .click();
    await until(
      async () => (await host.read("sessions", { workspaceId: ordinary.workspaceId })).length === 2,
      10000,
      "new coordinator chat"
    );
    await ordinaryRow.click({ button: "right" });
    assert.equal(
      await page.getByRole("menuitem", { name: /Make coordinator|Remove coordinator/ }).count(),
      0
    );
    passed = true;
    console.log("Board journey passed");
  } catch (error) {
    console.error("Board journey diagnostics:", dir);
    throw error;
  } finally {
    await browser?.close();
    await vite?.close();
    host?.close();
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "exit");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      await stopped;
      clearTimeout(timer);
    }
    await log.close();
    if (passed && !process.env.DEUS_BOARD_LAB_ROOT) await rm(dir, { recursive: true, force: true });
  }
}

if (process.send) await backendProcess();
else await run();
