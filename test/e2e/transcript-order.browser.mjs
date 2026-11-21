// The real app, SQLite and both event folds. A scripted engine feeds the backend's
// normal event handler. No model, CLI login or user database is needed.
// Run with Node 22: bunx tsx test/e2e/transcript-order.browser.mjs
// Append --electron-css to repeat with the packaged window's root class.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { open, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import Database from "better-sqlite3";
import { createServer } from "vite";
import { SCHEMA_SQL } from "../../shared/schema.ts";
import { LOOPBACK_WEB_ORIGINS } from "../../shared/web-origins.ts";
import { freePort } from "./remote-access/stack.mjs";
import { startPlatform, until } from "./cloud/platform.mjs";
import { connectBackend } from "./lib/operations.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const evidence = path.join(root, ".context/transcript-order");

const progress = [
  "I’ll start with the changed files.",
  "The entry point is in the session panel.",
  "I found the transcript query.",
  "The saved rows keep their order.",
  "I’m checking how the live events arrive.",
  "The turn contains several messages.",
  "Next I’ll check the activity groups.",
  "The file cards remain visible.",
  "I’ll compare a reload with the live view.",
  "The two views now agree.",
  "I’m running the focused checks.",
  "The checks passed.",
];

if (process.send) {
  const { getServerPort } = await import("../../apps/backend/src/server.ts");
  const { createAgentEventHandler } =
    await import("../../apps/backend/src/services/agent/event-handler.ts");
  const { LifecycleEventSchema } = await import("@zvada/agent-server/protocol");
  const engine = createAgentEventHandler();
  let seq = 0;
  process.on("message", (events) => {
    for (const input of events) {
      const event = LifecycleEventSchema.parse(input);
      engine.handle({ sessionId: event.sessionId, seq: ++seq, event });
    }
    process.send("written");
  });
  process.send(await until("backend listener", getServerPort));
} else {
  await run();
}

async function run() {
  await mkdir(evidence, { recursive: true });
  const directory = await mkdtemp(path.join(evidence, "run-"));
  const database = path.join(directory, "deus.db");
  const db = new Database(database);
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT INTO repositories (id, name, root_path) VALUES ('repo','Transcript',?)").run(
    directory
  );
  const chats = {};
  for (const name of ["order", "long", "nested", "refusal", "claude-code", "codex-app-server"]) {
    const workspace = crypto.randomUUID(),
      session = crypto.randomUUID();
    chats[name] = { workspace, session };
    db.prepare(
      "INSERT INTO workspaces (id,repository_id,slug,title,state,setup_status,current_session_id) VALUES (?,'repo',?,?,'ready','completed',?)"
    ).run(workspace, name, name, session);
    const add = db.prepare(
      "INSERT INTO sessions (id,workspace_id,agent_harness,title) VALUES (?,?,?,?)"
    );
    // Errors belong to a side chat, without the first chat's workspace-start marker.
    add.run(crypto.randomUUID(), workspace, "claude-code", "First chat");
    add.run(session, workspace, name === "codex-app-server" ? name : "claude-code", "Transcript");
    await mkdir(path.join(directory, ".deus", name), { recursive: true });
  }

  await writeFile(
    path.join(directory, "preferences.json"),
    JSON.stringify({ onboarding_completed: true, remote_access_enabled: false, theme: "dark" })
  );

  const log = await open(path.join(directory, "backend.log"), "w");
  const child = fork(new URL(import.meta.url), [], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", log.fd, log.fd, "ipc"],
    env: {
      ...process.env,
      PORT: "0",
      DATABASE_PATH: database,
      DEUS_VAULT_NO_KEYCHAIN: "1",
      AGENT_ALLOW_AGENTLESS: "1",
      DEUS_WEB_ORIGINS: LOOPBACK_WEB_ORIGINS,
      GIT_CEILING_DIRECTORIES: directory,
      TSX_TSCONFIG_PATH: path.join(root, "apps/backend/tsconfig.json"),
    },
  });
  const message = () =>
    once(child, "message", { signal: AbortSignal.timeout(45_000) }).then(([value]) => value);
  const emit = async (...events) => {
    const ack = message();
    child.send(events);
    assert.equal(await ack, "written");
  };
  let browser, vite, backend, platform;
  const failures = [];
  const check = async (name, test) => {
    try {
      await test();
      console.log("PASS", name);
    } catch (error) {
      failures.push(error);
      console.error("FAIL", name, error.message);
    }
  };
  try {
    const port = await message();
    backend = await connectBackend(`http://127.0.0.1:${port}`);
    const hosted = "ses_transcript";
    const summary = {
      id: hosted,
      status: "idle",
      workspace_id: "wsp_transcript",
      workspace_status: "running",
      sandbox_id: "sbx_transcript",
      title: "Hosted transcript",
      repo: "fixture/transcript",
      branch: "main",
      harness: "codex-app-server",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    platform = await startPlatform({
      bearer: "test-bearer",
      org: "org_transcript",
      sessions: [hosted],
      listSessions: () => [summary],
      snapshot: () => ({
        type: "session.snapshot",
        state: {
          sessionId: hosted,
          organizationId: "org_transcript",
          workspaceId: "wsp_transcript",
          status: "ready",
          currentTurnId: null,
        },
        messages: [],
        events: [],
      }),
    });
    vite = await createServer({
      configFile: path.join(root, "apps/web/vite.config.ts"),
      cacheDir: path.join(evidence, "vite-cache"),
      logLevel: "error",
      define: {
        "import.meta.env.VITE_BACKEND_PORT": JSON.stringify(String(port)),
        "import.meta.env.VITE_AGNT_BASE_URL": JSON.stringify(platform.url),
        "import.meta.env.VITE_DEUS_CLOUD_URL": JSON.stringify(platform.url),
      },
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
    browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
    });
    const desktopCss = process.argv.includes("--electron-css");
    if (desktopCss) {
      await context.addInitScript(() => {
        const doc = globalThis.document;
        if (doc.documentElement) doc.documentElement.classList.add("electron");
        else
          new globalThis.MutationObserver((_, observer) => {
            if (!doc.documentElement) return;
            doc.documentElement.classList.add("electron");
            observer.disconnect();
          }).observe(doc, { childList: true });
      });
    }
    const signIns = [];
    // The harness's advertised methods are test fixtures. A click must reach the login
    // for that harness. Neither the old terminal command nor a real OAuth flow runs.
    await context.routeWebSocket(
      (url) => url.pathname === "/ws",
      (route) => {
        const server = route.connectToServer();
        route.onMessage((raw) => {
          const f = JSON.parse(String(raw));
          if (f.resource === "agentAuth" && f.type === "q:request") {
            const harnesses = ["claude-code", "codex-app-server"];
            route.send(
              JSON.stringify({
                type: "q:response",
                id: f.id,
                data: {
                  clis: harnesses.map((harness) => ({ harness, state: "ready" })),
                  logins: [],
                  auth: harnesses.map((harness) => ({
                    harness,
                    state: "signed_out",
                    methods: [
                      { id: "browser-" + harness, kind: "browser", credential: "subscription" },
                    ],
                  })),
                },
              })
            );
          } else if (f.action === "agentSignIn") {
            signIns.push(f.params);
            route.send(
              JSON.stringify({
                type: "q:mutate_result",
                id: f.id,
                success: true,
                data: { already: { harness: f.params.harness, state: "signed_in", methods: [] } },
              })
            );
          } else if (f.type === "q:mutate" && /^(pty|terminal)/i.test(f.action)) {
            route.send(
              JSON.stringify({
                type: "q:mutate_result",
                id: f.id,
                success: false,
                error: "The fixture has no terminal",
              })
            );
          } else server.send(raw);
        });
        server.onMessage((raw) => route.send(raw));
      }
    );
    const page = await context.newPage();
    page.setDefaultTimeout(12_000);
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    const go = async (name) => {
      await page.goto(`${base}s/local/w/${chats[name].workspace}`, { timeout: 120_000 });
      await page.getByRole("log").waitFor();
    };
    const logView = page.getByRole("log");
    const order = () =>
      logView
        .locator(".assistant-turn p, button[aria-label*=' activity'], [role=separator][aria-label]")
        .evaluateAll((nodes) =>
          nodes.map((n) =>
            n.getAttribute("role") === "separator"
              ? n.getAttribute("aria-label")
              : n.tagName === "BUTTON"
                ? (n.innerText.match(/\d+ tool calls?/)?.[0] ?? "reasoning")
                : n.textContent
          )
        );
    await go("order");
    if (desktopCss) await page.locator("html.electron").waitFor();
    const turn = fixture(chats.order.session, "order");
    await emit(...turn.start("Check the transcript order."), turn.text("Progress A"), turn.tool());
    await logView.getByText("Progress A", { exact: true }).waitFor();
    const first = logView.getByRole("button", { name: /Expand activity/ });
    await first.click();
    const groupId = await logView
      .getByRole("button", { name: /Collapse activity/ })
      .getAttribute("aria-controls");
    const node = await page.locator(`[id="${groupId}"]`).elementHandle();
    await emit(turn.nextMessage(), turn.tool());
    await logView.getByRole("button", { name: /Collapse activity.*2 tool calls/ }).waitFor();
    assert(await node.evaluate((el) => el.isConnected), "growing the run kept its open DOM");
    await logView.getByRole("button", { name: /Collapse activity/ }).click();
    const c1 = turn.compact("first", "in_progress");
    await emit(c1);
    await logView.getByRole("separator", { name: "Compacting", exact: true }).waitFor();
    await emit(
      turn.text("Progress B"),
      turn.compact("first", "completed"),
      turn.tool(),
      turn.compact("second", "completed"),
      turn.text("Progress ", "streaming"),
      turn.delta("C")
    );
    await logView.getByText("Progress C", { exact: true }).waitFor();
    const expected = ["Progress A", "2 tool calls", "Progress B", "1 tool call", "Progress C"];
    await check("live progress continues while both completed compactions are held", async () =>
      assert.deepEqual(await order(), expected)
    );
    await page.reload();
    await logView.getByText("Progress C", { exact: true }).waitFor();
    await check("reattaching mid-turn reads the same order from SQLite", async () =>
      assert.deepEqual(await order(), expected)
    );
    await logView.getByRole("status", { name: /Working for/ }).waitFor();
    await emit(turn.delta(" continued"));
    await logView.getByText("Progress C continued", { exact: true }).waitFor();
    await emit(turn.finishText("Progress C continued"), turn.end("end_turn"));
    await logView.getByRole("button", { name: "Copy response" }).waitFor();
    await check("success puts both dividers after the turn and has one footer", async () => {
      await logView
        .getByRole("separator", { name: "Auto-compacted", exact: true })
        .nth(1)
        .waitFor();
      assert.deepEqual(await order(), [
        ...expected.slice(0, -1),
        "Progress C continued",
        "Auto-compacted",
        "Auto-compacted",
      ]);
      assert.equal(await logView.getByRole("button", { name: "Copy response" }).count(), 1);
    });
    const stop = fixture(chats.order.session, "stop");
    await emit(
      ...stop.start("Stop after this one."),
      stop.text("Before stopping"),
      { ...stop.compact("manual", "completed"), trigger: "manual" },
      stop.compact("error", "failed")
    );
    await page.reload();
    await logView.getByRole("separator", { name: "Compaction failed" }).waitFor();
    await logView.getByRole("status", { name: /Working for/ }).waitFor();
    await check(
      "a failed compaction stays visible and stopping releases the completed divider",
      async () => {
        assert.equal(
          await logView.getByRole("separator", { name: "Compacted", exact: true }).count(),
          0
        );
        await emit(stop.end("cancelled"));
        await logView.getByText("Response stopped", { exact: true }).waitFor();
        await logView.getByRole("separator", { name: "Compacted", exact: true }).waitFor();
        assert.equal(
          await logView.getByRole("separator", { name: "Auto-compacted", exact: true }).count(),
          2
        );
      }
    );

    await check("a task keeps child progress and activity nested across two messages", async () => {
      const task = fixture(chats.nested.session, "nested");
      const parent = task.tool("task");
      const childCall = parent.part.toolCallId;
      await emit(
        ...task.start("Review the nested activity."),
        parent,
        task.nextMessage(childCall),
        task.text("Child progress A"),
        task.tool(),
        task.nextMessage(childCall),
        task.tool(),
        task.text("Child progress B"),
        task.end("end_turn")
      );
      await go("nested");
      await logView
        .getByRole("button", { name: /Expand activity.*1 subagent.*1 tool call/ })
        .click();
      assert.equal(await logView.getByText("Child progress A", { exact: true }).count(), 0);
      await logView.getByRole("button", { name: "Expand agent Review the changes" }).click();
      await logView.getByText("Child progress B", { exact: true }).waitFor();
      assert.deepEqual(await order(), [
        "1 tool call",
        "Child progress A",
        "2 tool calls",
        "Child progress B",
      ]);
    });

    await check("the long turn has twelve independent, single-line groups", async () => {
      const long = fixture(chats.long.session, "long");
      const events = long.start("Review the changes and run the checks.");
      for (let i = 0; i < progress.length; i++) {
        events.push(long.text(progress[i]));
        for (let j = 0; j < (i % 3 === 0 ? 4 : 3); j++) events.push(long.tool());
      }
      await emit(...events, long.end("end_turn"));
      await page.setViewportSize({ width: 1280, height: 1360 });
      await go("long");
      await logView.getByText(progress.at(-1), { exact: true }).waitFor();
      const groups = logView.getByRole("button", { name: /Expand activity/ });
      const bounds = await groups.evaluateAll((nodes) =>
        nodes.map((n) => n.getBoundingClientRect().height)
      );
      assert.equal(bounds.length, 12);
      assert(bounds.every((h) => h === bounds[0] && h < 40));
      const top = await logView.boundingBox(),
        first = await logView.getByText(progress[0], { exact: true }).boundingBox(),
        last = await groups.last().boundingBox();
      assert(first.y >= top.y && last.y + last.height <= top.y + top.height);
      const counts = await groups.allTextContents();
      assert.equal(
        counts.reduce((sum, label) => sum + Number(label.match(/(\d+) tool calls/)[1]), 0),
        40
      );
      await logView.screenshot({
        path: path.join(evidence, desktopCss ? "long-turn-electron.png" : "long-turn.png"),
      });
      await groups.first().click();
      assert.equal(await logView.getByRole("button", { name: /Collapse activity/ }).count(), 1);
      assert.equal(await groups.count(), 11);
      await page.setViewportSize({ width: 1440, height: 900 });
    });

    await check("a refused first send stays visible on reopening an empty side chat", async () => {
      const sessionId = chats.refusal.session;
      await assert.rejects(
        backend.write("sendMessage", {
          sessionId,
          agentHarness: "codex-app-server",
          model: "test",
          content: "First send",
        }),
        /disconnected/
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id=?").get(sessionId).n,
        0
      );
      await go("refusal");
      await logView.getByRole("alert").getByText("Agent server is disconnected").waitFor();
      assert.equal(await logView.getByText("What would you like to work on?").count(), 0);
    });
    for (const harness of ["claude-code", "codex-app-server"]) {
      await check(`${harness} authentication starts its advertised sign-in`, async () => {
        const auth = fixture(chats[harness].session, "auth-" + harness);
        await emit(
          ...auth.start("Check sign-in."),
          auth.text("Checking the account."),
          auth.error("auth", "Sign in to continue.")
        );
        await go(harness);
        const card = logView.getByRole("alert");
        await card.getByText("Authentication Error").waitFor();
        await card.getByRole("button", { name: /^(Log in|Sign in)$/ }).click();
        await until(
          "the harness sign-in",
          () => signIns.some((s) => s.harness === harness && s.method === "browser-" + harness),
          3000
        );
      });
    }
    await check(
      "the rate-limit action creates a chat where the workspace supports it",
      async () => {
        const { session, workspace } = chats.order;
        const rate = fixture(session, "rate-local");
        await emit(
          ...rate.start("Try the account again."),
          rate.error("rate_limit", "Usage limit reached.")
        );
        await go("order");
        const card = logView.getByRole("alert");
        await card.getByText("Start a new chat to try again.", { exact: true }).waitFor();
        const count = () =>
          db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE workspace_id=?").get(workspace).n;
        const before = count();
        await card.getByRole("button", { name: "New chat", exact: true }).click();
        await until("the new local chat", () => count() === before + 1);
      }
    );
    await check(
      "hosted rate limits show the provider's retry time and available actions",
      async () => {
        const hostedPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        await hostedPage.addInitScript(() => {
          localStorage.setItem("deus.cloudDirectWeb", "1");
          sessionStorage.setItem("deus_cloud_session", "test-bearer");
        });
        await hostedPage.goto(base);
        await hostedPage.getByText("Hosted transcript", { exact: true }).first().click();
        await until("hosted session", () => platform.live(hosted));
        const rate = fixture(hosted, "rate");
        for (const frame of [...rate.start("Is the account ready?"), rate.text("Checking.")])
          platform.send(
            hosted,
            frame.type === "message.started" ? { ...frame, messageIndex: frame.outputIndex } : frame
          );
        const sentence = "Usage limit reached. Try again at 17:00 UTC.";
        platform.send(hosted, {
          type: "session.error",
          turnId: "rate",
          error: { code: "rate_limit", message: sentence },
          recoverable: false,
        });
        const card = hostedPage.getByRole("log").getByRole("alert");
        await card.getByText(sentence, { exact: true }).waitFor();
        assert.match(await card.innerText(), /Rate Limited/);
        assert.doesNotMatch(await card.innerText(), /new chat/i);
        await hostedPage.close();
      }
    );
    assert.deepEqual(pageErrors, []);
    if (failures.length)
      throw new AggregateError(failures, `${failures.length} transcript checks failed`);
  } finally {
    await browser?.close();
    await vite?.close();
    backend?.close();
    platform?.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exit = once(child, "exit");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exit;
      clearTimeout(timer);
    }
    await log.close();
    db.close();
  }
}

function fixture(sessionId, turnId) {
  let partIndex = 0,
    outputIndex = 1,
    messageId = turnId + "-reply-1";
  const event = (type, data = {}) => ({ type, sessionId, turnId, timestamp: Date.now(), ...data });
  const part = (type, data, index = partIndex++) =>
    event("message.part", {
      messageId,
      outputIndex,
      partIndex: index,
      part: { type, id: messageId + "-" + index, sessionId, messageId, ...data },
    });
  return {
    start(prompt) {
      const echo = turnId + "-user";
      return [
        event("turn.started"),
        event("message.started", { messageId: echo, outputIndex: 0, role: "user" }),
        event("message.part", {
          messageId: echo,
          outputIndex: 0,
          partIndex: 0,
          part: {
            id: echo + "-0",
            messageId: echo,
            sessionId,
            type: "text",
            text: prompt,
            state: "done",
          },
        }),
        event("message.started", { messageId, outputIndex, role: "assistant" }),
      ];
    },
    nextMessage(parentToolCallId) {
      messageId = turnId + "-reply-" + ++outputIndex;
      partIndex = 0;
      return event("message.started", {
        messageId,
        outputIndex,
        role: "assistant",
        parentToolCallId,
      });
    },
    text: (text, state = "done") => part("text", { text, state }),
    delta: (text) =>
      event("message.part.delta", {
        messageId,
        outputIndex,
        partIndex: partIndex - 1,
        partId: messageId + "-" + (partIndex - 1),
        delta: { type: "text", text },
      }),
    finishText: (text) => part("text", { text, state: "done" }, partIndex - 1),
    tool: (kind = "execute") =>
      part("tool", {
        toolCallId: messageId + "-call-" + partIndex,
        toolName: kind === "task" ? "Task" : "Bash",
        kind,
        state: {
          status: "completed",
          input:
            kind === "task" ? { description: "Review the changes" } : { command: "git status" },
          output: "done",
          time: { start: 1, end: 2 },
        },
      }),
    compact: (id, status) =>
      event("session.compaction", { compactionId: id, status, trigger: "auto" }),
    end: (stopReason) => event("turn.ended", { stopReason }),
    error: (category, message) => event("error", { category, message, recoverable: false }),
  };
}
