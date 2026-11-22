/* global window, document, requestAnimationFrame, DataTransfer, ClipboardEvent */
// Node 22 with --import tsx. Isolated backend, scripted cloud, SQLite, Chromium and Vite.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { chromium } from "playwright";
import { createServer } from "vite";
import { scriptedTurn, startPlatform } from "./cloud/platform.mjs";
import { seedToolTurn } from "./lib/setup-warning.mjs";
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
for (let i = 0; i < 12; i++) seedToolTurn(db, firstChat);
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

async function center(locator) {
  const box = await locator.boundingBox();
  return { x: Math.floor(box.x + box.width / 2), y: Math.floor(box.y + box.height / 2) };
}
const fileDrag = { items: [], files: [png], dragOperationsMask: 1 };
const dispatchDrag = (cdp, type, point, data = fileDrag) =>
  cdp.send("Input.dispatchDragEvent", { type, ...point, data });

// Chromium hit-tests each event. Hold at the center, where Home's overlay text
// appears. A DOM drop targeted at the textarea bypasses this retargeting.
async function dropPicture(page, input, surface) {
  await input.hover();
  const before = await preview(page).count();
  const point = await center(surface === "Home" ? input.locator("../..") : input);
  const cdp = await page.context().newCDPSession(page);
  const drag = (type) => dispatchDrag(cdp, type, point);
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
// The start composer sits inside the chat's drop surface so the same file bubbles through both.
const neighbor = path.join(directory, "neighbor.tsx");
await writeFile(
  neighbor,
  `
import React from "react";
import {createRoot} from "react-dom/client";
import {QueryClientProvider} from "@tanstack/react-query";
import {TooltipProvider} from "@/components/ui/tooltip";
import {queryClient} from "@/shared/api/queryClient";
import {WorkspaceStartComposer} from "@/features/session/ui/WorkspaceStartComposer";
const host = document.createElement("div");
host.id = "neighbor";
host.style.cssText = "position:fixed;right:10px;top:70px;width:420px;z-index:9999";
document.getElementById("chat-messages").after(host);
const root = createRoot(host);
root.render(<QueryClientProvider client={queryClient}><TooltipProvider><WorkspaceStartComposer workspace={{id:"neighbor",kind:"worktree"}} /></TooltipProvider></QueryClientProvider>);
export const unmount = () => {root.unmount();host.remove()};
`
);
const cloudChat = crypto.randomUUID();
const cloudWorkspace = crypto.randomUUID();
const sharedChat = "hosted-0";
const org = "org-drafts";
const bearer = (sub) =>
  "test." + Buffer.from(JSON.stringify({ sub })).toString("base64url") + ".test";
const memberA = bearer("account-a"),
  memberB = bearer("account-b");
const history = [];
let hostedSessions = ["Cloud chat"];
const platformOptions = {
  sessions: [cloudChat, sharedChat],
  org,
  snapshot: (id) => ({
    type: "session.snapshot",
    state: {
      sessionId: id,
      organizationId: org,
      workspaceId: id === sharedChat ? "workspace-0" : cloudWorkspace,
      status: "ready",
      currentTurnId: null,
    },
    messages: id === cloudChat ? history : [],
    events: [],
  }),
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
};
db.prepare(
  "INSERT INTO workspaces (id, repository_id, title, slug, state, kind, current_session_id, provider_workspace_id) VALUES (?, ?, 'Cloud fixture', 'cloud-fixture', 'ready', 'cloud', ?, ?)"
).run(cloudWorkspace, repo, cloudChat, cloudWorkspace);
db.prepare(
  "INSERT INTO sessions (id, workspace_id, agent_harness, status, provider_session_id) VALUES (?, ?, 'claude-code', 'idle', ?)"
).run(cloudChat, cloudWorkspace, cloudChat);
let vite, hosted, platform, secondMember, browser;
try {
  platform = await startPlatform({ ...platformOptions, bearer: memberA });
  const authToken = crypto.randomUUID();
  const host = await stack.host({
    name: "composer",
    database,
    dir: directory,
    authToken,
    env: {
      DEUS_USER_DATA_DIR: directory,
      TMPDIR: directory,
      AGENT_ALLOW_AGENTLESS: "0",
      AGNT_BASE_URL: platform.url,
      DEUS_CLOUD_AGNT_URL: platform.url,
      AGNT_API_KEY: "agnt_sk_fixture",
      DEUS_CLOUD_AGNT_API_KEY: "agnt_sk_fixture",
    },
  });
  await host.api("/settings/cloud/credentials", {
    method: "POST",
    headers: { authorization: "Bearer " + authToken },
    body: { deusCloudSessionToken: memberA },
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
  const tabs = page.getByRole("tablist", { name: "Session tabs" }).getByRole("tab");
  const data = [];
  let heldUpdates;
  let refusedId,
    refusal,
    lostId,
    lostReply,
    connections = 0;
  // Forward the write. Only its successful reply is lost between the host and this window.
  await page.routeWebSocket(/\/ws$/, (socket) => {
    connections++;
    const server = socket.connectToServer();
    server.onMessage(async (raw) => {
      const frame = JSON.parse(String(raw));
      if (heldUpdates && (frame.type === "q:snapshot" || frame.type === "q:delta"))
        await heldUpdates.promise;
      if (frame.type === "q:mutate_result" && frame.id === refusedId) refusal = frame;
      if (frame.type === "q:mutate_result" && frame.id === lostId) {
        lostReply = frame;
        socket.close({ code: 1011, reason: "Fixture lost the acknowledgement" });
        server.close();
        return;
      }
      socket.send(raw);
    });
    socket.onMessage((raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === "q:mutate" && frame.action === "sendMessage") {
        data.push(frame.params);
        if (frame.params.sessionId !== cloudChat) {
          // Reject local fixture sends at the host's busy check before a CLI could run.
          db.prepare("UPDATE sessions SET status = 'working' WHERE id = ?").run(
            frame.params.sessionId
          );
        }
        if (frame.params.sessionId === firstChat) refusedId = frame.id;
        if (frame.params.sessionId === cloudChat) lostId = frame.id;
      }
      server.send(raw);
    });
  });
  const paste = (field, data) =>
    field.evaluate((el, content) => {
      const clipboardData = new DataTransfer();
      if (typeof content === "string") clipboardData.setData("text/plain", content);
      else {
        clipboardData.items.add(
          new File([Uint8Array.from(content)], "pasted.png", { type: "image/png" })
        );
      }
      el.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData })
      );
    }, data);
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
      await page.getByRole("button", { name: /Dismiss missing/ }).click();
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
  const automationPrompt = "Create a scheduled automation for this repo. It should: ";
  const takeAutomationPrompt = async () => {
    await page.getByRole("button", { name: "Automations", exact: true }).click();
    await page.getByRole("button", { name: "New automation", expanded: false }).click();
    await page.getByRole("menuitem", { name: "Create with AI" }).click();
    return homeInput(page).inputValue();
  };
  await check("Requesting the automation prompt twice leaves it once", async () => {
    await homeInput(page).fill("");
    assert.equal(await takeAutomationPrompt(), automationPrompt);
    assert.equal(await takeAutomationPrompt(), automationPrompt);
  });
  await check("An automation prompt replaces existing Home text", async () => {
    await homeInput(page).fill("My earlier draft");
    assert.equal(await takeAutomationPrompt(), automationPrompt);
  });
  await page.goto(url(chatWorkspace));
  await check("Chat file drop", () => dropPicture(page, input, "Chat"));
  await check(
    "Two chats keep separate drafts and attachments through close and restore",
    async () => {
      await page.goto(url(tabsWorkspace));
      await input.fill("First chat draft");
      const pasted = page.getByRole("button", { name: "Preview image pasted.png" });
      await paste(input, Array.from(await readFile(png)));
      await pasted.waitFor();
      await page.getByRole("button", { name: "New chat tab", exact: true }).click();
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
  await check("New chat shows the reason after another client archives the workspace", async () => {
    await page.goto(url(tabsWorkspace));
    const newChat = page.getByRole("button", { name: "New chat tab", exact: true });
    await newChat.waitFor();
    heldUpdates = Promise.withResolvers();
    try {
      await host.write("archiveWorkspace", { workspaceId: tabsWorkspace });
      await newChat.click();
      const toast = page.locator('[data-sonner-toast][data-type="error"]');
      assert.equal(
        await toast.innerText(),
        "This workspace is archived. Restore it first to open a chat."
      );
    } finally {
      heldUpdates.resolve();
      heldUpdates = undefined;
    }
  });
  const largePaste = "A line of the oversized paste.\n".repeat(210000);
  {
    await page.goto(url(chatWorkspace));
    const transcript = page.locator("#chat-messages");
    await transcript.locator("[data-message-id]").first().waitFor();
    const first = await center(main(page).getByPlaceholder(/^Ask a follow-up/));
    const fixture = "/@fs" + neighbor;
    await page.evaluate((entry) => import(entry), fixture);
    const other = page.locator("#neighbor");
    const next = other.locator("textarea");
    await next.waitFor();
    const last = await center(next);
    assert(
      await next.evaluate((el, p) => el === document.elementFromPoint(p.x, p.y), last),
      "Neighbor textarea is hit-testable"
    );
    const cdp = await context.newCDPSession(page);
    const drag = (type, position, data) => dispatchDrag(cdp, type, position, data);
    const overlay = page.getByText("Drop images here", { exact: true });
    try {
      await check("A drag across two mounted composers attaches only at the last", async () => {
        assert(
          await transcript.evaluate((el) => {
            el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
            return el.scrollTop > 0 && el.scrollTop + el.clientHeight < el.scrollHeight;
          }),
          "Transcript scrolled into its history"
        );
        const before = await preview(page).count();
        await drag("dragEnter", first);
        await drag("dragOver", first);
        await overlay.waitFor();
        await drag("dragOver", { x: last.x - 1, y: last.y });
        await drag("dragOver", last);
        await other.getByText("Drop images here").waitFor();
        await drag("drop", last);
        await other.getByRole("button", { name: "Preview image screenshot.png" }).waitFor();
        assert.equal(await preview(page).count(), before + 1);
        assert.equal(await overlay.count(), 0);
      });
      await check("A non-file drag shows no image drop overlay", async () => {
        const text = {
          items: [{ mimeType: "text/plain", data: "plain text" }],
          dragOperationsMask: 1,
        };
        await drag("dragEnter", first, text);
        await drag("dragOver", first, text);
        assert.equal(await overlay.count(), 0);
        await drag("dragCancel", first, text);
      });
      const dropOutside = async (surface, start) => {
        const outside = await center(surface);
        const before = page.url(),
          pages = context.pages().length;
        await drag("dragEnter", start ?? outside);
        await drag("dragOver", outside);
        await page.evaluate(() => {
          for (const name of ["dragover", "drop"])
            window.addEventListener(name, (e) => (window.outsideFileEvent = e), {
              capture: true,
              once: true,
            });
        });
        await drag("dragOver", outside);
        await drag("drop", outside);
        assert.equal(page.url(), before);
        assert.equal(context.pages().length, pages);
        assert(
          await page.evaluate(() => {
            const last = window.outsideFileEvent;
            return (
              last?.defaultPrevented &&
              (last.type === "drop" || last.dataTransfer.dropEffect === "none")
            );
          }),
          "Browser default file navigation was not cancelled"
        );
        await surface.waitFor();
      };
      await check("Dropping a file outside both targets keeps this page", () =>
        dropOutside(
          page.getByRole("button", { name: "New workspace in Drafts", exact: true }),
          first
        )
      );
      await check("A file drop in Settings keeps the page without a composer", async () => {
        await page.goto(base + "/settings");
        const back = page.getByRole("button", { name: "Back to app" });
        await back.waitFor();
        await page.getByLabel("Send message", { exact: true }).waitFor({ state: "detached" });
        await dropOutside(back);
      });
    } finally {
      await cdp.detach();
      if (await other.count())
        await page.evaluate(async (entry) => (await import(entry)).unmount(), fixture);
    }
  }
  await page.goto(url(chatWorkspace));
  await check("A refused send keeps the draft through a reload", async () => {
    await input.fill("Refused draft");
    await input.press("Enter");
    await until(() => refusal?.success === false, 5000, "backend refusal");
    await page.locator("[data-sonner-toast]").first().waitFor();
    db.prepare("UPDATE sessions SET status = 'idle' WHERE id = ?").run(firstChat);
    await page.reload();
    await value(input, "Refused draft");
  });
  await check("A send with a lost reply appears once across reconnect and reload", async () => {
    await page.goto(url(cloudWorkspace));
    await until(() => platform.socketsFor(cloudChat).length > 0, 10000, "cloud host socket");
    await input.fill("uncertain send");
    const before = connections;
    await input.press("Enter");
    await until(() => lostReply?.success === true, 7000, "host accepted the write");
    await page
      .locator("[data-sonner-toast]")
      .filter({ hasText: "The operation may have completed; check its result before retrying" })
      .waitFor();
    await until(() => connections > before, 10000, "page reconnected after losing the reply");
    const admitted = platform.commands(cloudChat).filter((c) => c.type === "message.send");
    assert.equal(admitted.length, 1);
    const wire = data.find((f) => f.sessionId === cloudChat);
    assert.equal(admitted[0].turnId, wire.turnId);
    const turn = scriptedTurn(platform, cloudChat, admitted[0]);
    turn.start();
    turn.finishReply();
    turn.end();
    history.push(...turn.rows());
    const bubble = page.locator("[data-message-id]").getByText("uncertain send", { exact: true });
    await page.getByText(turn.reply, { exact: true }).waitFor();
    await bubble.waitFor();
    // Known gap: the draft still stands after an uncertain send, even when the host echoes it.
    await value(input, "uncertain send");
    await page.reload();
    await bubble.waitFor();
    await value(input, "uncertain send");
    assert.equal(platform.commands(cloudChat).filter((c) => c.type === "message.send").length, 1);
  });
  await page.goto(url(startWorkspace));
  await check("Start file drop", () => dropPicture(page, input, "Start"));
  await check(
    "Start draft survives reload and adding a picture keeps the missing-picture line",
    async () => {
      await input.fill("Start draft");
      await page.reload();
      await value(input, "Start draft");
      await notice(page, 1).waitFor();
      await dropPicture(page, input, "Start");
      await notice(page, 1).waitFor();
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
      await input.fill("my");
      await paste(input, largePaste);
      await paste(input, "Another clipboard note\n".repeat(30));
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
      await page
        .getByText("1 picture and 2 pasted texts were not kept. Add them again.", { exact: true })
        .waitFor();
      await input.locator("..").screenshot({
        path: path.join(evidence, "restored-attachments.png"),
        animations: "disabled",
      });
      assert.equal(data.filter((f) => f.content === "first waiting message").length, 1);
    }
  );
  async function checkFreshChat(workspace, name, test) {
    await check(name, async () => {
      const p = await context.newPage();
      try {
        await p.goto(url(workspace));
        await test(p, main(p).getByPlaceholder(/^Ask a follow-up/));
      } finally {
        await p.close();
      }
    });
  }
  await checkFreshChat(
    chatWorkspace,
    "Typing after a 6.51 MB paste in the same chat survives reload",
    async (p, field) => {
      await field.fill("Before paste");
      await paste(field, largePaste);
      await p
        .getByText(/^A line of the oversized paste/)
        .first()
        .waitFor();
      await field.fill("After the large paste");
      await p.reload();
      await value(field, "After the large paste");
      await p.getByText("1 pasted text was not kept. Add it again.", { exact: true }).waitFor();
      assert.equal(await p.getByText(/^A line of the oversized paste/).count(), 0);
    }
  );
  await checkFreshChat(
    cloudWorkspace,
    "A full browser store keeps a live edit and a reload leaves the sent draft empty",
    async (p, field) => {
      const errors = [];
      p.on("pageerror", (error) => errors.push(error.message));
      const sent = "Send this once";
      await field.fill(sent);
      await openHome(p);
      await p.evaluate(() => {
        const block = "x".repeat(64 * 1024);
        try {
          for (let i = 0; ; i++) sessionStorage.setItem("quota-fixture:" + i, block);
        } catch (error) {
          if (error.name !== "QuotaExceededError") throw error;
        }
      });
      const live = "Still typing ".repeat(7000);
      await homeInput(p).fill(live);
      await main(p)
        .getByRole("button", { name: /Cloud fixture/ })
        .click();
      await value(field, sent);
      await field.press("Enter");
      await until(() =>
        platform.commands(cloudChat).some((c) => c.type === "message.send" && c.text === sent)
      );
      await value(field, "");
      await openHome(p);
      await value(homeInput(p), live);
      await p.goto(url(cloudWorkspace));
      await field.press("End");
      await field.press("x");
      assert.equal(await field.inputValue(), "x");
      assert.deepEqual(errors, []);
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
    await p.waitForFunction(
      async ({ id, client, keys }) => {
        const { queryClient } = await import(client);
        const { queryKeys } = await import(keys);
        return queryClient.getQueryData(queryKeys.deusCloud.session)?.accountId === id;
      },
      {
        id: accountId,
        client: "/src/shared/api/queryClient.ts",
        keys: "/src/shared/api/queryKeys.ts",
      }
    );
  };
  let single = await launchDesktop();
  try {
    let p = single.p;
    await p.goto(base);
    await openWorkspace(chatWorkspace, p);
    assert(await p.locator("html.electron").count(), "Desktop CSS is active");
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
    await check(
      "Deleting a start puts its waiting text and picture ahead of Home's typed text",
      async () => {
        await openHome(p);
        await homeInput(p).fill("Already on Home");
        await openWorkspace(failed.workspaceId, p);
        const first = chatInput(p);
        await first.fill("See my picture");
        await dropPicture(p, first, "Start");
        await first.press("Enter");
        await p.locator('[data-slot="waiting-message"]').getByText("See my picture").waitFor();
        await p.getByRole("button", { name: "Delete", exact: true }).click();
        await value(homeInput(p), "See my picture\n\nAlready on Home");
        const picture = p.getByRole("button", { name: /^Preview image / }).getByRole("img");
        assert.equal(
          await picture.getAttribute("src"),
          "data:image/png;base64," + (await readFile(png, "base64"))
        );
      }
    );
  } finally {
    await single.desktop.close();
  }
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
      memberA
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
  await check(
    "Two hosted members keep separate drafts in the same chat across sign-in and reload",
    async () => {
      secondMember = await startPlatform({ ...platformOptions, bearer: memberB });
      const p = await context.newPage();
      p.setDefaultTimeout(8000);
      try {
        // Each membership fixture accepts its own bearer and grants access to the same org/chat.
        await p.route(platform.url + "/dashboard/**", async (route) => {
          if (route.request().headers().authorization !== "Bearer " + memberB)
            return route.continue();
          await route.fulfill({
            response: await route.fetch({
              url: route.request().url().replace(platform.url, secondMember.url),
            }),
          });
        });
        let member = memberA;
        await p.route(platform.url + "/auth/login?**", (route) => {
          const back = new URL(new URL(route.request().url()).searchParams.get("return_to"));
          back.hash = "token=" + member;
          return route.fulfill({ status: 302, headers: { location: back.href } });
        });
        const openShared = async () => {
          await p.waitForFunction(
            (expected) => sessionStorage.getItem("deus_cloud_session") === expected,
            member
          );
          await p.getByText("Cloud chat", { exact: true }).first().click();
          await chatInput(p).waitFor();
        };
        const switchMember = async (token) => {
          member = token;
          await p.evaluate(async (moduleUrl) => {
            const auth = await import(moduleUrl);
            auth.clearWebCloudSession();
            auth.beginWebCloudLogin();
          }, "/src/features/session/cloud/webCloudDirectConfig.ts");
          await openShared();
        };
        await p.goto(origin);
        await openShared();
        await chatInput(p).fill("A's private draft");
        await p.reload();
        await value(chatInput(p), "A's private draft");
        await switchMember(memberB);
        await value(chatInput(p), "");
        await chatInput(p).fill("B's private draft");
        await p.reload();
        await value(chatInput(p), "B's private draft");
        assert(secondMember.tokens > 0, "B opened the shared chat with B's own token");
        await switchMember(memberA);
        await value(chatInput(p), "A's private draft");
        await p.reload();
        await value(chatInput(p), "A's private draft");
      } finally {
        await p.close();
      }
    }
  );
  assert.deepEqual(failures, []);
} finally {
  await browser?.close();
  await hosted?.close();
  await secondMember?.close();
  await platform?.close();
  await vite?.close();
  await stack.close();
  db.close();
}
