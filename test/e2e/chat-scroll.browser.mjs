import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright";
import { build } from "vite";

// Bundle the real transcript and styles in memory. The fixture supplies data locally.
const fixture = fileURLToPath(new URL("./fixtures/chat-scroll.ts", import.meta.url));
const source = fileURLToPath(new URL("../../apps/web/src", import.meta.url));
const shared = fileURLToPath(new URL("../../shared", import.meta.url));
const sessionId = "scroll-fixture";
let browser;
let page;
let script;
let styles;

before(async () => {
  const bundle = await build({
    configFile: false,
    logLevel: "error",
    resolve: { alias: { "@": source, "@shared": shared } },
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
    esbuild: { jsx: "automatic" },
    plugins: [
      {
        name: "transcript-fixture-data",
        enforce: "pre",
        resolveId(id) {
          if (id.endsWith("/settings.queries")) return "\0fixture-settings";
          if (id === "./CloudEnvProgress") return "\0fixture-cloud-env";
        },
        load(id) {
          if (id === "\0fixture-settings")
            return `export const useSettings = () => ({ data: { chat_view: 'bubbles' } });
              export const useAgentAuth = () => ({ data: undefined });`;
          if (id === "\0fixture-cloud-env")
            return `const entries = [];
              export const useCloudEnvEntries = () => entries;
              export const CloudEnvGroup = () => null;`;
        },
      },
      tailwindcss(),
    ],
    build: {
      write: false,
      lib: { entry: fixture, name: "ChatScrollFixture", formats: ["iife"] },
      rollupOptions: {
        onwarn(warning, warn) {
          if (warning.code !== "MODULE_LEVEL_DIRECTIVE") warn(warning);
        },
      },
    },
  });
  const { output } = Array.isArray(bundle) ? bundle[0] : bundle;
  script = output.find((chunk) => chunk.type === "chunk").code;
  styles = output.find((asset) => asset.fileName.endsWith(".css")).source;
  browser = await chromium.launch();
});

beforeEach(async () => {
  page = await browser.newPage({ reducedMotion: "no-preference" });
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => route.abort());
  await page.setContent('<div id="root"></div>');
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: script });
  assert.deepEqual(errors, []);
});

afterEach(() => page?.close());
after(() => browser?.close());

function text(messageId, words) {
  return {
    type: "text",
    text: words,
    state: "done",
    id: `text-${messageId}`,
    sessionId,
    messageId,
  };
}

function send(messageId, index) {
  const id = `send-${messageId}-${index}`;
  return {
    id,
    type: "tool",
    kind: "other",
    toolCallId: id,
    toolName: "tell_user",
    mcp: { server: "deus_chat_tools", tool: "tell_user" },
    sessionId,
    messageId,
    state: {
      status: "completed",
      input: { message: `Update ${index}` },
      output: "Message sent.",
      time: { start: 1, end: 2 },
    },
  };
}

function history(first, last) {
  return Array.from({ length: last - first + 1 }, (_, i) => {
    const n = i + first;
    const base = { session_id: sessionId, turn_id: `turn-${n}`, sent_at: null };
    const user = `user-${n}`;
    const reply = `reply-${n}`;
    return [
      { ...base, id: user, seq: n * 2, role: "user", parts: [text(user, `Question ${n}`)] },
      { ...base, id: reply, seq: n * 2 + 1, role: "assistant", parts: [text(reply, `Reply ${n}`)] },
    ];
  }).flat();
}

function renderChat(props, height = 530) {
  return page.evaluate(
    ([data, viewport]) => globalThis.window.renderChat("chat", viewport, data),
    [props, height]
  );
}

function renderPane(props) {
  return page.evaluate((data) => globalThis.window.renderPane("pane", data), props);
}

async function waitAtBottom(selector = "#chat-messages") {
  await page.waitForFunction((id) => {
    const pane = globalThis.document.querySelector(id);
    return pane && pane.scrollHeight - pane.clientHeight - pane.scrollTop <= 1;
  }, selector);
  await waitFrames(14); // Let the chase idle before triggering the next resize.
}

function waitFrames(count) {
  return page.evaluate(async (frames) => {
    for (let i = 0; i < frames; i++)
      await new Promise((done) => globalThis.requestAnimationFrame(done));
  }, count);
}

function rowOffset(id) {
  return page.locator(`[data-message-id="${id}"]`).evaluate((row) => {
    const pane = row.closest("#chat-messages");
    return row.getBoundingClientRect().top - pane.getBoundingClientRect().top;
  });
}

test("gentle upward movement pauses an active chase", async () => {
  await renderPane({ count: 1, height: 900 });
  await waitAtBottom("#pane");
  const result = await page.evaluate(async () => {
    const pane = globalThis.document.querySelector("#pane");
    const tail = globalThis.document.querySelector("#tail");
    const bottom = pane.scrollTop;
    tail.style.height = "1000px";
    for (let i = 0; i < 12 && pane.scrollTop === bottom; i++) {
      await new Promise((done) => globalThis.requestAnimationFrame(done));
    }
    const start = pane.scrollTop;
    for (let i = 1; i <= 30; i++) {
      tail.style.height = `${1000 + i * 32}px`;
      pane.scrollTop -= 1;
      await new Promise((done) => globalThis.requestAnimationFrame(done));
    }
    return { paused: pane.dataset.paused, bottom, start, end: pane.scrollTop };
  });
  assert.ok(result.start > result.bottom, `chase did not start: ${JSON.stringify(result)}`);
  assert.equal(result.paused, "true");
  assert.ok(result.end < result.start, JSON.stringify(result));
});

test("a height-neutral prepend does not consume the next live resize", async () => {
  await renderPane({ count: 1, height: 900 });
  await waitAtBottom("#pane");
  await renderPane({ count: 2, height: 900 });
  await page.locator("#tail").evaluate((tail) => (tail.style.height = "1280px"));
  await waitAtBottom("#pane");
});

test("live growth follows after a loading placeholder with the same message count", async () => {
  await renderPane({ count: 1, height: 900, loading: true });
  await renderPane({ count: 1, height: 900, loading: false });
  await waitAtBottom("#pane");
  await page.locator("#tail").evaluate((tail) => (tail.style.height = "1200px"));
  await waitAtBottom("#pane");
});

test("prepending with a concurrent append preserves the row through delayed measurement", async () => {
  await renderChat({ messages: history(22, 34), hasOlder: true });
  await waitAtBottom();
  const pane = page.locator("#chat-messages");
  await pane.evaluate((node) => {
    node.scrollTop = 0;
  });
  await waitFrames(4);
  const before = await rowOffset("user-22");
  await pane.getByRole("button", { name: "Load earlier messages" }).click();
  await renderChat({ messages: history(1, 35), hasOlder: true });
  await waitFrames(18);
  const restored = await rowOffset("user-22");
  assert.ok(Math.abs(restored - before) <= 2, `anchor moved from ${before} to ${restored}`);

  await pane.locator('[data-message-id="reply-21"]').evaluate((row) => {
    const spacer = globalThis.document.createElement("div");
    spacer.style.height = "150px";
    row.firstElementChild.append(spacer);
  });
  await waitFrames(18);
  const measured = await rowOffset("user-22");
  assert.ok(Math.abs(measured - before) <= 2, `anchor moved from ${before} to ${measured}`);
});

test("a short prepend keeps the scroll range at zero and can still follow", async () => {
  const pane = page.locator("#chat-messages");
  await renderChat({ messages: history(22, 22), hasOlder: true }, 640);
  await waitAtBottom();
  await pane.getByRole("button", { name: "Load earlier messages" }).click();
  const messages = history(21, 22);
  await renderChat({ messages, hasOlder: true }, 640);
  await waitAtBottom();
  assert.equal(await pane.evaluate((node) => node.scrollTop), 0);

  const reply = messages.at(-1);
  const props = {
    messages,
    sessionStatus: "working",
    turns: [{ turnId: reply.turn_id, startedAt: Date.now() - 1000 }],
    hasOlder: true,
  };
  await renderChat(props, 640);
  await waitAtBottom();
  reply.parts = Array.from({ length: 26 }, (_, i) => send(reply.id, i));
  await renderChat(props, 640);
  await waitAtBottom();
  assert.ok(await pane.evaluate((node) => node.scrollTop > 0));
});

test("opening Worked near the top keeps the disclosure in view", async () => {
  const messages = history(1, 7);
  const reply = messages.at(-1);
  reply.parts.unshift(...Array.from({ length: 18 }, (_, i) => send(reply.id, i)));
  await renderChat({ messages, hasOlder: true }, 278);
  await waitAtBottom();
  const button = page.getByRole("button", { name: /Expand activity, Worked/ });
  const position = (locator) =>
    locator.evaluate((node) => {
      const pane = node.closest("#chat-messages");
      return node.getBoundingClientRect().top - pane.getBoundingClientRect().top;
    });
  const before = await position(button);
  assert.ok(before > 0 && before < 64, `Worked should be near the top (${before})`);
  await button.click();
  await waitFrames(24);
  const after = await position(page.getByRole("button", { name: /Collapse activity, Worked/ }));
  assert.ok(Math.abs(after - before) <= 2, `Worked moved from ${before} to ${after}`);
});

test("same-message growth follows past a trailing failed compaction", async () => {
  const messages = history(1, 7);
  const reply = messages.at(-1);
  const props = {
    messages,
    sessionStatus: "working",
    turns: [{ turnId: reply.turn_id, startedAt: Date.now() - 1000 }],
    compactions: [
      {
        compaction_id: "failed",
        turn_id: reply.turn_id,
        status: "failed",
        trigger: "auto",
        created_at: new Date().toISOString(),
      },
    ],
  };
  reply.parts = [send(reply.id, 0)];
  await renderChat(props);
  await page.getByRole("separator", { name: "Compaction failed" }).waitFor();
  await waitAtBottom();
  reply.parts = Array.from({ length: 35 }, (_, i) => send(reply.id, i));
  await renderChat(props);
  await waitAtBottom();
});

test("final growth follows when the last part and turn end land together without agent messages", async () => {
  const messages = history(1, 7);
  const reply = messages.at(-1);
  const turn = { turnId: reply.turn_id, startedAt: Date.now() - 1000 };
  await renderChat({ messages, turns: [turn], sessionStatus: "working", agentMessages: false });
  await waitAtBottom();
  reply.parts = [text(reply.id, "Final details from the turn.\n\n".repeat(36))];
  await renderChat({ messages, turns: [{ ...turn, endedAt: Date.now() }], agentMessages: false });
  await waitAtBottom();
});
