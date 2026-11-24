// Node 22: bunx tsx test/e2e/usage-limit.browser.mjs
// A scripted engine supplies the limits. The renderer, socket, queue and turn admission are real.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, open, writeFile } from "node:fs/promises";
import path from "node:path";
import { mock } from "node:test";
import { createUserEchoParts, echoMessageId } from "@zvada/agent-server/protocol/factories";
import Database from "better-sqlite3";
import { chromium } from "playwright";
import { createServer } from "vite";
import { SCHEMA_SQL } from "../../shared/schema.ts";
import { LOOPBACK_WEB_ORIGINS } from "../../shared/web-origins.ts";
import { connectBackend } from "./lib/operations.mjs";
import { freePort, until } from "./remote-access/stack.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const proof = path.join(root, ".context/proof/8");
const start = Date.UTC(2026, 10, 24, 5, 9);
const reset = start + 60_000;
const limitMessage = "Your plan limit resets at 5:10am.";
const harness = "codex-app-server";
const model = "gpt-5.4";

if (process.send) await engine();
else await journey();

async function engine() {
  const { AgentLink } = await import("../../apps/backend/src/services/agent/client.ts");
  let deliver,
    seq = 0;
  const starts = [];
  function emit({ sessionId, turnId }, type, fields) {
    deliver({
      sessionId,
      seq: ++seq,
      event: { type, sessionId, turnId, timestamp: Date.now(), ...fields },
    });
  }
  mock.method(AgentLink, "open", async ({ onEnvelope }) => {
    deliver = onEnvelope;
    return {
      getAgents: () => [{ type: harness, capabilities: { images: true } }],
      isConnected: () => true,
      close() {},
      engine: {
        onAuthUpdated: () => () => {},
        onCliProgress: () => () => {},
        listClis: async (harnesses) => harnesses.map((harness) => ({ harness, state: "ready" })),
        authStatus: async ({ harnesses }) =>
          harnesses.map((harness) => ({ harness, state: "signed_out", methods: [] })),
        listModels: async ({ harness: id }) => ({
          harness: id,
          source: "live",
          models:
            id === harness
              ? [{ id: model, label: "GPT-5.4", harness, thinking: { levels: ["medium"] } }]
              : [],
        }),
      },
      startTurn(turn) {
        starts.push(turn);
        emit(turn, "turn.started", {
          execution: { harness, model: turn.config.model, thinkingLevel: "medium" },
        });
        const messageId = echoMessageId(turn.turnId);
        const address = { messageId, outputIndex: 0 };
        emit(turn, "message.started", { ...address, role: "user", origin: turn.origin });
        for (const [partIndex, part] of createUserEchoParts(turn.input, turn.turnId).entries()) {
          emit(turn, "message.part", {
            ...address,
            partIndex,
            part: { ...part, messageId, sessionId: turn.sessionId },
          });
        }
        emit(turn, "message.ended", { messageId });
      },
    };
  });
  const { getServerPort } = await import("../../apps/backend/src/server.ts");
  await until(() => getServerPort() && deliver);
  mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: start });
  process.on("message", ({ type, sessionId, resetsAt, milliseconds }) => {
    if (type === "limit") {
      const turn = starts.findLast((entry) => entry.sessionId === sessionId);
      emit(turn, "session.limits", {
        status: "limited",
        windows: [
          { id: "five_hour", usedPercent: 100, resetsAt },
          { id: "seven_day", usedPercent: 20, resetsAt: reset + 86_400_000 },
        ],
      });
      emit(turn, "turn.ended", {
        stopReason: "error",
        error: { category: "usage_limit", message: limitMessage },
      });
    }
    if (type === "tick") mock.timers.tick(milliseconds);
    process.send(starts.map(({ sessionId, input }) => ({ sessionId, input })));
  });
  process.send(getServerPort());
}

async function journey() {
  await mkdir(proof, { recursive: true });
  const directory = await mkdtemp(path.join(root, ".context/limited-chat-"));
  const database = path.join(directory, "deus.db");
  const db = new Database(database);
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT INTO repositories (id, name, root_path) VALUES ('repo', 'Workbench', ?)").run(
    directory
  );
  const workspace = crypto.randomUUID();
  const chats = Object.fromEntries(
    [
      "Queued follow-up",
      "Empty queue",
      "Cancelled",
      "Person sent first",
      "No reset time",
      "Automatic",
      "Opened after reset",
    ].map((title) => [title, crypto.randomUUID()])
  );
  db.prepare(
    "INSERT INTO workspaces (id, repository_id, slug, title, state, current_session_id) VALUES (?, 'repo', 'limits', 'Usage limits', 'ready', ?)"
  ).run(workspace, chats["Queued follow-up"]);
  for (const [title, id] of Object.entries(chats)) {
    db.prepare(
      "INSERT INTO sessions (id, workspace_id, title, agent_harness) VALUES (?, ?, ?, ?)"
    ).run(id, workspace, title, harness);
  }
  db.close();
  await mkdir(path.join(directory, ".deus/limits"), { recursive: true });
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
      TSX_TSCONFIG_PATH: path.join(root, "apps/backend/tsconfig.json"),
    },
  });
  const reply = () =>
    once(child, "message", { signal: AbortSignal.timeout(45_000) }).then(([message]) => message);
  const drive = (command) => {
    const result = reply();
    child.send(command);
    return result;
  };
  let backend, vite, browser;
  try {
    const port = await reply();
    backend = await connectBackend("http://127.0.0.1:" + port);
    vite = await createServer({
      configFile: path.join(root, "apps/web/vite.config.ts"),
      cacheDir: path.join(directory, "vite-cache"),
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
    const base = vite.resolvedUrls.local[0] + "s/local";
    browser = await chromium.launch();
    async function windowFor(colorScheme, { phone = false, now = start } = {}) {
      const page = await browser.newPage({
        viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
        isMobile: phone,
        hasTouch: phone,
        locale: "en-GB",
        timezoneId: "UTC",
        colorScheme,
        reducedMotion: "reduce",
      });
      // Pin the wall clock. Motion starts Web Animations against the document's native performance clock.
      await page.addInitScript((time) => {
        Date.now = () => time;
        globalThis.Date = new Proxy(Date, {
          apply: (NativeDate) => new NativeDate(time).toString(),
          construct: (NativeDate, args, newTarget) =>
            Reflect.construct(NativeDate, args.length ? args : [time], newTarget),
        });
      }, now);
      page.setDefaultTimeout(20_000);
      return page;
    }
    const page = await windowFor("light");
    const visit = async (window, sessionId) => {
      await window.bringToFront();
      await window.goto(base + "/w/" + workspace + "?session=" + sessionId);
      const card = window.getByRole("log").getByRole("alert");
      await card.getByText("Usage limit reached", { exact: true }).waitFor();
      return card;
    };
    const screenshot = async (window, filename, card) => {
      if (card) {
        await until(
          () => card.evaluate((el) => Number(globalThis.getComputedStyle(el).opacity) >= 0.99),
          20_000,
          `the card in ${filename} to finish appearing`
        );
      }
      await window.screenshot({ path: path.join(proof, filename), animations: "disabled" });
    };
    const send = (sessionId, content) =>
      backend.write("sendMessage", {
        sessionId,
        content,
        model,
        agentHarness: harness,
        thinkingLevel: "medium",
      });
    const queue = (sessionId) => backend.read("queuedMessages", { sessionId });
    const limit = (sessionId, resetsAt) => drive({ type: "limit", sessionId, resetsAt });
    const first = "Check the workspace changes.";
    const followup = "Review the tests next.";
    const personal = "Read my latest changes.";
    const queued = chats["Queued follow-up"];
    const empty = chats["Empty queue"];
    const cancelled = chats.Cancelled;
    const person = chats["Person sent first"];
    const unknown = chats["No reset time"];
    const automatic = chats.Automatic;
    const late = chats["Opened after reset"];
    for (const id of [queued, empty, cancelled, person, late]) {
      await send(id, first);
      if (id === queued || id === late) await send(id, followup);
      await limit(id, reset);
    }

    const queueCard = await visit(page, queued);
    await queueCard.getByText("Resets at 05:10.").waitFor();
    assert.equal(await queueCard.getByText(limitMessage, { exact: true }).count(), 0);
    const group = page.getByRole("group", { name: "Queued messages" });
    await group.getByText("Queue paused until 05:10.").waitFor();
    await group.getByText(followup).waitFor();
    await group.getByRole("button", { name: "Resume" }).waitFor();
    await screenshot(page, "limit-light.png", queueCard);
    await queueCard.getByRole("button", { name: "Continue at 05:11" }).click();
    const scheduled = "Continues at 05:11 while Deus stays open.";
    await queueCard.getByText(scheduled).waitFor();

    const dark = await windowFor("dark");
    const darkCard = await visit(dark, queued);
    await darkCard.getByText(scheduled).waitFor();
    await dark.locator("html.dark").waitFor({ state: "attached" });
    await screenshot(dark, "limit-dark.png", darkCard);

    const phone = await windowFor("light", { phone: true });
    const phoneCard = await visit(phone, empty);
    await phoneCard.getByRole("button", { name: "Continue at 05:11" }).tap();
    await phoneCard.getByText(scheduled).waitFor();
    assert.equal(await phone.getByRole("button", { name: "Resume", exact: true }).count(), 0);
    const phoneButton = await phoneCard.getByRole("button", { name: "Cancel" }).boundingBox();
    assert(
      phoneButton.height >= 44 && phoneButton.x >= 0 && phoneButton.x + phoneButton.width <= 390
    );
    await screenshot(phone, "limit-phone.png", phoneCard);

    for (const id of [cancelled, person]) {
      const card = await visit(page, id);
      await card.getByRole("button", { name: "Continue at 05:11" }).click();
      await card.getByText(scheduled).waitFor();
      if (id === cancelled) {
        await card.getByRole("button", { name: "Cancel" }).click();
        await card.getByRole("button", { name: "Continue at 05:11" }).waitFor();
        assert.equal((await queue(id)).limit.continues, false);
      } else {
        const composer = page.locator('[data-slot="main-content"] textarea').first();
        await composer.fill(personal);
        await composer.press("Enter");
        await page.getByRole("log").getByText(personal, { exact: true }).waitFor();
        await until(async () => (await queue(id)).limit === undefined);
      }
    }

    await page.goto(base + "/settings");
    await page.getByRole("button", { name: "AI Providers" }).click();
    const setting = page.getByRole("switch", {
      name: "When a usage limit resets, continue the chats it stopped.",
    });
    assert.equal(await setting.getAttribute("aria-checked"), "false");
    await setting.click();
    await until(async () => (await backend.read("settings")).continue_after_usage_limit === true);
    await until(async () => (await setting.getAttribute("aria-checked")) === "true");
    await screenshot(page, "limit-setting.png");
    await send(unknown, first);
    await send(unknown, followup);
    await limit(unknown);
    const noTime = await visit(page, unknown);
    await group.getByText("Queue paused. A usage limit was reached.", { exact: true }).waitFor();
    await noTime.getByText(limitMessage, { exact: true }).waitFor();
    assert.equal(await noTime.getByRole("button").count(), 0);
    assert.equal(await noTime.getByText(/Resets at/).count(), 0);
    await send(automatic, first);
    await limit(automatic, reset);
    const automaticCard = await visit(page, automatic);
    await automaticCard.getByText(scheduled).waitFor();

    // Node runs expired timers at the end of each tick. Visit the host's 05:10 check on time.
    await drive({ type: "tick", milliseconds: reset - start });
    const afterReset = await drive({ type: "tick", milliseconds: 30_000 });
    assert.equal(afterReset.length, 8, "Only the seven initial sends and the person's message ran");
    const reopened = await windowFor("light", { now: reset + 30_000 });
    const lateCard = await visit(reopened, late);
    await lateCard.getByText("Reset at 05:10.").waitFor();
    await reopened
      .getByRole("group", { name: "Queued messages" })
      .getByText("Queue paused. A usage limit was reached.", { exact: true })
      .waitFor();
    const continueNow = lateCard.getByRole("button", { name: "Continue", exact: true });
    await continueNow.waitFor();
    await screenshot(reopened, "limit-after-reset.png", lateCard);
    await continueNow.click();
    await reopened.getByRole("log").getByText(followup, { exact: true }).waitFor();

    const before = await drive({ type: "tick", milliseconds: 29_999 });
    assert.equal(before.length, 9, "Only the explicit Continue ran before 05:11");
    await drive({ type: "tick", milliseconds: 1 });
    await until(
      async () => (await drive({ type: "starts" })).length === 12,
      15_000,
      "the three scheduled turns"
    );
    const starts = await drive({ type: "tick", milliseconds: 120_000 });
    for (const [id, expected] of [
      [queued, [first, followup]],
      [empty, [first, "Continue."]],
      [automatic, [first, "Continue."]],
      [person, [first, personal]],
      [cancelled, [first]],
      [unknown, [first]],
      [late, [first, followup]],
    ]) {
      assert.deepEqual(
        starts.filter((s) => s.sessionId === id).map((s) => s.input),
        expected
      );
    }
    await dark.getByRole("log").getByText(followup, { exact: true }).waitFor();
    await phone.getByRole("log").getByText("Continue.", { exact: true }).waitFor();
    console.log(
      "PASS scheduled chats, Cancel, a person's send, empty queues, unknown resets and an immediate Continue after reset; light, dark and phone."
    );
  } finally {
    await browser?.close();
    await vite?.close();
    backend?.close();
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "exit");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      await stopped;
      clearTimeout(timer);
    }
    await log.close();
  }
}
