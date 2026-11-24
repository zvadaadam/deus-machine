// Real renderer, WebSocket, queue and SQLite. The scripted engine lets the next turn start
// while one of the browser's original write frames is still in flight.
// Run with Node 22: bunx tsx test/e2e/queued-messages.browser.mjs
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, open, writeFile } from "node:fs/promises";
import path from "node:path";
import { mock } from "node:test";
import {
  createUserEchoParts,
  echoMessageId,
  createSteerEchoParts,
  steerMessageId,
} from "@zvada/agent-server/protocol/factories";
import Database from "better-sqlite3";
import { chromium } from "playwright";
import { createServer } from "vite";
import { SCHEMA_SQL } from "../../shared/schema.ts";
import { LOOPBACK_WEB_ORIGINS } from "../../shared/web-origins.ts";
import { connectBackend } from "./lib/operations.mjs";
import { freePort, until } from "./remote-access/stack.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const evidence = path.join(root, ".context/queue-controls");
const harness = "codex-app-server";
const model = "gpt-5.4";

if (process.send) await engine();
else await run();

function watchLayout() {
  const doc = globalThis.document;
  globalThis.layoutShift = null;
  const sample = () => {
    if (globalThis.layoutShift) return;
    for (const anchor of doc.querySelectorAll(
      '[data-slot="workspace-header"], [data-slot="main-content"] textarea'
    )) {
      for (let parent = anchor.parentElement; parent; parent = parent.parentElement) {
        if (parent.scrollLeft || parent.scrollTop) {
          globalThis.layoutShift = {
            element: parent.getAttribute("data-slot") ?? parent.tagName,
            x: parent.scrollLeft,
            y: parent.scrollTop,
          };
          return;
        }
      }
    }
  };
  doc.addEventListener("scroll", sample, true);
  function paint() {
    sample();
    globalThis.requestAnimationFrame(paint);
  }
  globalThis.requestAnimationFrame(paint);
}

async function assertLayout(page) {
  assert.equal(
    await page.evaluate(() => globalThis.layoutShift),
    null,
    "A composer or header ancestor scrolled"
  );
  const overflow = await page.evaluate(() => {
    const { scrollWidth, clientWidth, scrollHeight, clientHeight } = globalThis.document.body;
    return [scrollWidth - clientWidth, scrollHeight - clientHeight];
  });
  assert.deepEqual(overflow, [0, 0], "The app shell extends beyond the viewport");
}

async function assertStatusFits(status) {
  await status.waitFor();
  assert(
    await status.evaluate((el) => {
      const range = globalThis.document.createRange();
      range.selectNodeContents(el);
      const text = range.getBoundingClientRect();
      const rail = el.parentElement.getBoundingClientRect();
      const message = el.parentElement.previousElementSibling.getBoundingClientRect();
      return (
        range.getClientRects().length === 1 &&
        message.right <= text.left &&
        rail.left <= text.left &&
        text.right <= rail.right
      );
    }),
    "The full status must fit on one line beside the message"
  );
}

async function engine() {
  const { AgentLink } = await import("../../apps/backend/src/services/agent/client.ts");
  let deliver,
    seq = 0;
  const starts = [],
    steers = [];
  function emit(type, { sessionId, turnId }, fields) {
    deliver({
      sessionId,
      seq: ++seq,
      event: { type, sessionId, turnId, timestamp: Date.now(), ...fields },
    });
  }
  mock.method(AgentLink, "open", async ({ onEnvelope }) => {
    deliver = onEnvelope;
    return {
      startTurn(params) {
        starts.push(params);
        emit("turn.started", params);
      },
      getAgents: () => [{ type: harness, capabilities: { images: true } }],
      isConnected: () => true,
      close() {},
      engine: {
        steerTurn(params) {
          steers.push(params);
          return Promise.resolve({ outcome: "steered", steerId: params.steerId });
        },
        onAuthUpdated: () => () => {},
        onCliProgress: () => () => {},
        listModels: async ({ harness: id }) => ({
          harness: id,
          source: "live",
          models:
            id === harness
              ? [{ id: model, harness, label: "GPT-5.4", thinking: { levels: ["medium"] } }]
              : [],
        }),
      },
    };
  });
  const { getServerPort } = await import("../../apps/backend/src/server.ts");
  await until(() => getServerPort() && deliver);
  process.on("message", (command) => {
    const turn = starts.at(-1);
    if (command === "end") emit("turn.ended", turn, { stopReason: "end_turn" });
    if (command === "echo" || command === "read") {
      const steer = command === "read" ? steers.at(-1) : null;
      const { input, sessionId, turnId } = steer ?? turn;
      const messageId = steer ? steerMessageId(steer.steerId) : echoMessageId(turnId);
      const outputIndex = steer ? 2 : 0;
      emit("message.started", turn, { messageId, outputIndex, role: "user" });
      const parts = steer
        ? createSteerEchoParts(input, steer.steerId)
        : createUserEchoParts(input, turnId);
      for (const [partIndex, part] of parts.entries()) {
        emit("message.part", turn, {
          messageId,
          outputIndex,
          partIndex,
          part: { ...part, messageId, sessionId },
        });
      }
      emit("message.ended", turn, { messageId });
    }
    process.send({
      starts: starts.map((p) => p.input),
      steers: steers.map(({ turnId, input }) => ({ turnId, input })),
    });
  });
  process.send(getServerPort());
}

async function run() {
  await mkdir(evidence, { recursive: true });
  const directory = await mkdtemp(path.join(evidence, "run-"));
  const database = path.join(directory, "deus.db");
  const db = new Database(database);
  const workspace = crypto.randomUUID(),
    sessionId = crypto.randomUUID(),
    backgroundWorkspace = crypto.randomUUID(),
    backgroundSession = crypto.randomUUID();
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT INTO repositories (id, name, root_path) VALUES ('repo', 'Workbench', ?)").run(
    directory
  );
  db.prepare(
    "INSERT INTO workspaces (id, repository_id, slug, title, state, current_session_id) VALUES (?, 'repo', 'review', 'Review compositor', 'ready', ?)"
  ).run(workspace, sessionId);
  db.prepare(
    "INSERT INTO sessions (id, workspace_id, agent_harness, title) VALUES (?, ?, ?, 'Queue controls')"
  ).run(sessionId, workspace, harness);
  db.prepare(
    "INSERT INTO workspaces (id, repository_id, slug, title, state, current_session_id) VALUES (?, 'repo', 'follow-up', 'Follow up', 'ready', ?)"
  ).run(backgroundWorkspace, backgroundSession);
  db.prepare("INSERT INTO sessions (id, workspace_id, agent_harness) VALUES (?, ?, ?)").run(
    backgroundSession,
    backgroundWorkspace,
    harness
  );
  db.close();
  await mkdir(path.join(directory, ".deus/review"), { recursive: true });
  await mkdir(path.join(directory, ".deus/follow-up"), { recursive: true });
  await writeFile(
    path.join(directory, "preferences.json"),
    JSON.stringify({ onboarding_completed: true, remote_access_enabled: false })
  );
  const log = await open(path.join(directory, "backend.log"), "w");
  const child = fork(new URL(import.meta.url), [], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", log.fd, log.fd, "ipc"],
    env: {
      ...process.env,
      PORT: "0",
      DATABASE_PATH: database,
      DEUS_USER_DATA_DIR: directory,
      DEUS_VAULT_NO_KEYCHAIN: "1",
      DEUS_WEB_ORIGINS: LOOPBACK_WEB_ORIGINS,
      GIT_CEILING_DIRECTORIES: directory,
      AGENT_ALLOW_AGENTLESS: "0",
      TSX_TSCONFIG_PATH: path.join(root, "apps/backend/tsconfig.json"),
    },
  });
  const reply = () =>
    once(child, "message", { signal: AbortSignal.timeout(45000) }).then(([data]) => data);
  const drive = (command) => {
    const answer = reply();
    child.send(command);
    return answer;
  };
  let backend, vite, browser, page;
  try {
    const port = await reply();
    backend = await connectBackend(`http://127.0.0.1:${port}`);
    vite = await createServer({
      configFile: path.join(root, "apps/web/vite.config.ts"),
      cacheDir: path.join(evidence, "vite-cache"),
      logLevel: "error",
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
    const url = vite.resolvedUrls.local[0] + "s/local/w/" + workspace;
    browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      permissions: ["clipboard-read", "clipboard-write"],
    });
    await context.addInitScript(watchLayout);
    page = await context.newPage();
    page.on("pageerror", (error) => console.error(error.message));
    page.setDefaultTimeout(12000);
    page.setDefaultNavigationTimeout(90000);
    const hold = new Set(),
      held = [],
      results = new Map();
    await page.routeWebSocket(/\/ws$/, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((raw) => {
        const frame = JSON.parse(String(raw));
        if (frame.type === "q:mutate_result") results.set(frame.id, frame);
        socket.send(raw);
      });
      socket.onMessage((raw) => {
        const frame = JSON.parse(String(raw));
        if (frame.type === "q:mutate" && hold.has(frame.action)) {
          held.push({ frame, forward: () => server.send(raw) });
        } else server.send(raw);
      });
    });
    const send = (content) =>
      backend.write("sendMessage", { sessionId, content, model, agentHarness: harness });
    const queue = () => backend.read("queuedMessages", { sessionId });
    const A = "Review the keyboard shortcuts.";
    const B = "Check the mobile layout.";
    const C = "Verify the drag handles.";
    const D = "Update the release notes.";
    const note = "Keep the existing shortcuts.";
    const { turnId } = await send(A);
    await drive("echo");
    await page.goto(url);
    const transcript = page.getByRole("log");
    await transcript.getByText(A, { exact: true }).waitFor({ timeout: 45000 });
    await page.getByRole("button", { name: "Hide workspace" }).click();
    await send(B);
    await send(C);
    await send(D);
    const group = page.getByRole("group", { name: "Queued messages" });
    const input = page.locator('[data-slot="main-content"] textarea').first();
    const order = () => group.locator("span[title]").allTextContents();
    const shows = (expected) =>
      until(
        async () => JSON.stringify(await order()) === JSON.stringify(expected),
        8000,
        JSON.stringify(expected)
      );
    const steerRow = (text) =>
      group
        .getByText(text, { exact: true })
        .locator("..")
        .locator("..")
        .getByRole("button", { name: "Send to current turn", exact: true });
    const release = async () => {
      const next = held.shift();
      assert(next);
      next.forward();
      await until(() => results.has(next.frame.id));
      return results.get(next.frame.id).data;
    };
    const grip = (n) =>
      group.getByRole("button", { name: "Reorder queued message " + n, exact: true });
    await shows([B, C, D]);
    const rowsOpen = () =>
      until(() =>
        group
          .locator("span[title]")
          .evaluateAll((spans) =>
            spans.every(
              (span) => span.closest(".overflow-hidden").getBoundingClientRect().height >= 35.9
            )
          )
      );
    await rowsOpen();

    // Move the last follow-up to the front. The display keeps the drop until the real write lands.
    hold.add("moveQueuedMessage");
    await grip(3).focus();
    await page.keyboard.press("Space");
    const announce = (position) =>
      group.getByText(position, { exact: true }).waitFor({ state: "attached" });
    await group
      .locator('[aria-live="assertive"]')
      .filter({ hasText: "3 of 3" })
      .waitFor({ state: "attached" });
    const painted = () =>
      page.evaluate(
        () =>
          new Promise((resolve) =>
            globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve))
          )
      );
    await painted();
    await page.keyboard.press("ArrowUp");
    await announce("Position 2 of 3.");
    await page.keyboard.press("ArrowUp");
    await announce("Position 1 of 3.");
    await page.keyboard.press("Space");
    await until(() => held.length === 1);
    await shows([D, B, C]);
    assert.deepEqual(
      (await queue()).items.map((item) => item.text),
      [B, C, D]
    );
    assert.deepEqual(await release(), { moved: true });
    await shows([D, B, C]);

    // Drag it back below the others with the pointer.
    const source = await grip(1).boundingBox(),
      target = await grip(3).boundingBox();
    const x = source.x + source.width / 2;
    await page.mouse.move(x, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, target.y + target.height / 2, { steps: 12 });
    await page.screenshot({ path: path.join(evidence, "queue-drag.png") });
    await page.mouse.up();
    await until(() => held.length === 1);
    assert.deepEqual(await release(), { moved: true });
    await shows([B, C, D]);

    // If another window removes the target mid-drop, canonical order wins.
    const extra = "Check the empty state.";
    const last = await send(extra);
    await shows([B, C, D, extra]);
    await rowsOpen();
    await grip(1).focus();
    await page.keyboard.press("Space");
    await painted();
    await page.keyboard.press("ArrowDown");
    await announce("Position 2 of 4.");
    await page.keyboard.press("ArrowDown");
    await announce("Position 3 of 4.");
    await page.keyboard.press("Space");
    await until(() => held.length === 1);
    await shows([C, D, B, extra]);
    assert.equal(held[0].frame.params.before, last.turnId);
    await backend.write("removeQueuedMessage", { sessionId, id: last.turnId });
    assert.deepEqual(await release(), { moved: false });
    await shows([B, C, D]);
    hold.delete("moveQueuedMessage");
    console.log("PASS keyboard and pointer moves, held write, refused drop");

    // A normal row steer is delivered once, including on a double click.
    await send(extra);
    await steerRow(extra).dblclick();
    await group.getByText("Waiting to be read").waitFor();
    assert.deepEqual((await drive("state")).steers, [{ turnId, input: extra }]);
    await steerRow(B).hover();
    await page.getByRole("tooltip", { name: "Send to current turn" }).waitFor();
    await page.mouse.move(0, 0);
    await painted();
    await page.mouse.move(800, 250);
    await page.getByRole("tooltip", { name: "Send to current turn" }).waitFor({ state: "hidden" });
    let phone;
    for (const [label, options] of [
      ["desktop", null],
      ["phone", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
    ]) {
      const device = options ? await browser.newPage(options) : page;
      if (options) {
        await device.addInitScript(watchLayout);
        await device.goto(url);
      }
      await assertStatusFits(device.getByText("Waiting to be read", { exact: true }));
      for (const theme of ["light", "dark"]) {
        await device.evaluate(
          (dark) => globalThis.document.documentElement.classList.toggle("dark", dark),
          theme === "dark"
        );
        await assertLayout(device);
        await device.screenshot({ path: path.join(evidence, `queue-${label}-${theme}.png`) });
      }
      if (label === "phone") phone = device;
    }
    const phoneQueue = phone.getByRole("group", { name: "Queued messages" });
    for (const button of await phoneQueue.getByRole("button").all()) {
      const box = await button.boundingBox();
      assert(box.width >= 44 && box.height >= 44, await button.getAttribute("aria-label"));
    }
    const touch = await phone.context().newCDPSession(phone);
    const bounds = await phoneQueue.boundingBox();
    const tip = { x: bounds.x + bounds.width / 3, y: bounds.y + bounds.height - 20 };
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [tip] });
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ ...tip, y: tip.y - 75 }],
    });
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await until(() => phoneQueue.evaluate((el) => el.scrollTop > 0));
    const phoneTab = await phone
      .getByRole("tablist", { name: "Session tabs" })
      .getByRole("tab", { selected: true })
      .boundingBox();
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: phoneTab.x + phoneTab.width / 2, y: phoneTab.y + phoneTab.height / 2 }],
    });
    await phone.getByRole("menuitem", { name: "Copy link" }).waitFor();
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await phone.keyboard.press("Escape");
    await touch.detach();
    await drive("read");

    // Hold both original WebSocket frames until A has ended and B has started.
    hold.add("steerQueuedMessage");
    hold.add("steerMessage");
    await steerRow(D).dblclick();
    await input.fill(note);
    const mac = await page.evaluate(() => /Mac/i.test(navigator.userAgent));
    await input.press(mac ? "Meta+Enter" : "Control+Enter");
    await until(() => held.length === 2);
    assert.deepEqual(
      held.map(({ frame }) => [frame.action, frame.params.turnId]),
      [
        ["steerQueuedMessage", turnId],
        ["steerMessage", turnId],
      ]
    );
    await drive("end");
    await assertStatusFits(group.getByText("Sending", { exact: true }));
    await until(async () => (await drive("state")).starts.at(-1) === B);
    await assertStatusFits(phoneQueue.getByText("Sending", { exact: true }));
    await phone.screenshot({ path: path.join(evidence, "queue-phone-sending.png") });
    await assertLayout(phone);
    await phone.close();
    await page.evaluate((text) => {
      // The two surfaces subscribe separately. Sample actual paints until the bubble is visible.
      globalThis.handoff = new Promise((resolve, reject) => {
        let missing = 0;
        const timer = setTimeout(
          () => reject(new Error("The queue row never became a bubble")),
          8000
        );
        function visible(element) {
          if (!element) return false;
          let { top, bottom } = element.getBoundingClientRect();
          for (let el = element; el; el = el.parentElement) {
            const css = globalThis.getComputedStyle(el);
            if (Number(css.opacity) < 0.1) return false;
            if (css.overflowY !== "visible") {
              const clip = el.getBoundingClientRect();
              top = Math.max(top, clip.top);
              bottom = Math.min(bottom, clip.bottom);
            }
          }
          return bottom - top >= 4;
        }
        function sample() {
          const findText = (selector) =>
            [...globalThis.document.querySelectorAll(selector)].find(
              (el) => el.textContent === text
            );
          if (visible(findText("#chat-messages [id^=message-content-]"))) {
            clearTimeout(timer);
            return resolve(missing);
          }
          if (!visible(findText('[aria-label="Queued messages"] span[title]'))) missing++;
          globalThis.requestAnimationFrame(sample);
        }
        sample();
      });
    }, B);
    await drive("echo");
    await transcript.getByText(B, { exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => globalThis.handoff),
      0,
      "A painted frame lost both row and bubble"
    );
    assert.deepEqual(await release(), { outcome: "queued" });
    await shows([D, C]);
    assert.deepEqual(await release(), { outcome: "queued" });
    await shows([note, D, C]);
    assert.deepEqual(await drive("state"), { starts: [A, B], steers: [{ turnId, input: extra }] });
    for (const text of [note, D, C]) {
      await drive("end");
      await until(async () => (await drive("state")).starts.at(-1) === text);
      await drive("echo");
      await transcript.getByText(text, { exact: true }).waitFor();
    }
    await drive("end");
    console.log("PASS A-to-B held composer and row steers, queue order delivered");

    const row = page.locator(`[data-workspace-id="${workspace}"]`);
    await row.click({ button: "right" });
    const copy = page.getByRole("menuitem", { name: "Copy link", exact: true });
    const captureMenu = async (filename) => {
      await copy.waitFor();
      await copy.evaluate((item) =>
        Promise.all(
          item
            .closest('[role="menu"]')
            .getAnimations()
            .map((animation) => animation.finished)
        )
      );
      await assertLayout(page);
      await page.screenshot({ path: path.join(evidence, filename) });
    };
    await captureMenu("workspace-menu.png");
    await copy.click();
    const clipboardIs = (link) =>
      until(async () => (await page.evaluate(() => navigator.clipboard.readText())) === link);
    await clipboardIs(url);
    const openByKeyboard = async (target, key = "Shift+F10") => {
      await page.locator('[role="menu"]').first().waitFor({ state: "detached" });
      await target.focus();
      await page.keyboard.press(key);
      await copy.waitFor();
    };
    await openByKeyboard(row);
    await page.keyboard.press("Escape");
    const focused = (target) => target.evaluate((el) => el === globalThis.document.activeElement);
    await until(() => focused(row), 8000, "focus on the workspace after Escape");
    const activate = async (name, key) => {
      const item = page.getByRole("menuitem", { name, exact: true });
      const menu = page.locator('[role="menu"][data-state="open"]').filter({ has: item });
      await until(
        () => menu.evaluate((el) => el.contains(globalThis.document.activeElement)),
        8000,
        "focus inside the open menu for " + name
      );
      await page.keyboard.press("Home");
      for (const candidate of await menu.getByRole("menuitem").all()) {
        await until(() => focused(candidate), 8000, "keyboard focus on the next menu item");
        if (await focused(item)) break;
        await page.keyboard.press("ArrowDown");
      }
      assert(await focused(item), "Menu focus on " + name);
      await page.keyboard.press(key);
    };
    const sibling = page.locator(`[data-workspace-id="${backgroundWorkspace}"]`);
    const visited = [];
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) visited.push(frame.url());
    });
    await openByKeyboard(sibling);
    await activate("Copy link", "Enter");
    await clipboardIs(url.replace(workspace, backgroundWorkspace));
    await until(() => focused(sibling));
    await openByKeyboard(sibling);
    await activate("Set status", "ArrowRight");
    await activate("In Review", "Space");
    const siblingState = () => backend.read("workspace", { workspaceId: backgroundWorkspace });
    await until(async () => (await siblingState()).status === "in-review");
    await until(() => focused(sibling), 8000, "focus on the workspace after setting its status");
    await openByKeyboard(sibling);
    await activate("Archive workspace", "Enter");
    await until(async () => (await siblingState()).state === "archived");
    assert(!visited.some((link) => link.includes(backgroundWorkspace)));
    assert.equal(await row.getAttribute("aria-current"), "page");
    const tabs = page.getByRole("tablist", { name: "Session tabs" });
    const label = await tabs.getByRole("tab", { selected: true }).innerText();
    await page.getByRole("button", { name: "New chat tab" }).click();
    const tab = tabs.getByRole("tab", { name: label, exact: true });
    await tab.click({ button: "right" });
    await captureMenu("chat-menu.png");
    await copy.click();
    await clipboardIs(url + "?session=" + sessionId);
    assert.equal(await tab.getAttribute("aria-selected"), "false");
    await openByKeyboard(tab, "ContextMenu");
    await page.keyboard.press("Escape");
    await until(() => focused(tab), 8000, "focus on the inactive chat after Escape");
    await openByKeyboard(tab);
    await activate("Copy link", "Space");
    await clipboardIs(url + "?session=" + sessionId);
    await until(() => focused(tab));
    assert.equal(await tab.getAttribute("aria-selected"), "false");
    await openByKeyboard(tab, "ContextMenu");
    await activate("Close tab", "Enter");
    await tab.waitFor({ state: "detached" });
    assert.equal(await tabs.getByRole("tab").count(), 1);
    await assertLayout(page);
    console.log(
      "PASS desktop and phone shell fit their viewport; every header and composer ancestor stayed at 0,0"
    );
    console.log(
      "PASS sidebar and inactive tab links by pointer and keyboard; Escape restores focus; Set status, Archive and Close act only on their target"
    );
  } catch (error) {
    if (page) {
      console.error(await page.locator("body").innerText({ timeout: 3000 }));
      await page.screenshot({ path: path.join(directory, "failure.png") });
    }
    throw error;
  } finally {
    await browser?.close();
    await vite?.close();
    backend?.close();
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "exit");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      await stopped;
      clearTimeout(timer);
    }
    await log.close();
  }
}
