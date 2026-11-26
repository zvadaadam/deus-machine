import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { chromium } from "playwright";
import { expect } from "playwright/test";
import { build } from "vite";

// Bundle the real transcript and styles in memory. The fixture supplies data locally.
const fixture = fileURLToPath(new URL("./fixtures/chat-scroll.ts", import.meta.url));
const source = fileURLToPath(new URL("../../apps/web/src", import.meta.url));
const shared = fileURLToPath(new URL("../../shared", import.meta.url));
const sessionId = "scroll-fixture";
const liveTurnStartedAt = Date.now();
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
        resolveId(id, importer) {
          if (id.endsWith("/settings.queries")) return "\0fixture-settings";
          if (id === "./CloudEnvProgress") return "\0fixture-cloud-env";
          if (
            id === "@tanstack/react-virtual" &&
            importer?.endsWith("/useTranscriptVirtualizer.ts")
          )
            return "\0fixture-virtualizer";
        },
        load(id) {
          if (id === "\0fixture-settings")
            return `export const useSettings = () => ({ data: { chat_view: 'bubbles' } });
              export const useAgentAuth = () => ({ data: undefined });`;
          if (id === "\0fixture-virtualizer")
            return `export * from "@tanstack/react-virtual";
              import { useVirtualizer as useRealVirtualizer } from "@tanstack/react-virtual";
              export function useVirtualizer(options) {
                const instance = useRealVirtualizer(options);
                globalThis.chatVirtualizer = instance;
                return instance;
              }`;
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
  await page.setContent('<meta name="viewport" content="width=device-width"><div id="root"></div>');
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

function send(messageId, index, message = `Update ${index}`) {
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
      input: { message },
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

function liveUpdates(count) {
  const messages = history(1, 7);
  const reply = messages.at(-1);
  reply.parts = Array.from({ length: count }, (_, i) =>
    send(reply.id, i + 1, `Update ${i + 1}\n\nThe agent is still checking.`)
  );
  return {
    messages,
    sessionStatus: "working",
    turns: [{ turnId: reply.turn_id, startedAt: liveTurnStartedAt }],
  };
}

function failedCompaction(turnId) {
  return {
    compaction_id: "failed",
    turn_id: turnId,
    status: "failed",
    trigger: "auto",
    created_at: new Date().toISOString(),
  };
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
    await new Promise((done) => globalThis.setTimeout(done, 0));
  }, count);
}

function scrollPosition() {
  return page.locator("#chat-messages").evaluate((pane) => ({
    top: pane.scrollTop,
    bottom: pane.scrollHeight - pane.clientHeight,
    paused: globalThis.document
      .querySelector('button[aria-label="Scroll to bottom"]')
      .parentElement.classList.contains("opacity-100"),
  }));
}

function rowOffset(id) {
  return page.locator(`[data-message-id="${id}"]`).evaluate((row) => {
    const pane = row.closest("#chat-messages");
    return row.getBoundingClientRect().top - pane.getBoundingClientRect().top;
  });
}

async function growRowPastTop(id, height) {
  const crossing = await page.locator(`[data-message-id="${id}"]`).evaluate((row, height) => {
    const viewportTop = row.closest("#chat-messages").getBoundingClientRect().top;
    const oldEnd = row.getBoundingClientRect().bottom - viewportTop;
    const spacer = globalThis.document.createElement("div");
    spacer.style.height = `${height}px`;
    row.firstElementChild.append(spacer);
    return { oldEnd, newEnd: row.getBoundingClientRect().bottom - viewportTop };
  }, height);
  assert.ok(crossing.oldEnd <= 0 && crossing.newEnd > 0, JSON.stringify(crossing));
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
    const readerTop = pane.scrollTop;
    tail.style.height = "2400px";
    await new Promise(globalThis.requestAnimationFrame);
    await new Promise((done) =>
      globalThis.requestAnimationFrame(() => globalThis.setTimeout(done, 0))
    );
    return { paused: pane.dataset.paused, bottom, start, end: pane.scrollTop, readerTop };
  });
  assert.ok(result.start > result.bottom, `chase did not start: ${JSON.stringify(result)}`);
  assert.equal(result.paused, "true");
  assert.ok(result.end < result.start, JSON.stringify(result));
  assert.equal(result.end, result.readerTop, "more live growth must respect the reader's scroll");
});

for (const reducedMotion of ["reduce", "no-preference"]) {
  test(`an idle chat follows a small live resize until the reader scrolls up (${reducedMotion})`, async () => {
    await page.emulateMedia({ reducedMotion });
    await renderChat(liveUpdates(15));
    await waitAtBottom();
    const before = await scrollPosition();
    await renderChat(liveUpdates(16));
    await waitFrames(40);
    const followed = await scrollPosition();
    assert.ok(followed.bottom - before.bottom > 24);
    assert.equal(followed.top, followed.bottom, "follow the newly measured bottom");
    assert.equal(followed.paused, false);

    await page.locator("#chat-messages").evaluate((pane) => pane.scrollBy(0, -32));
    await waitFrames(2);
    const reader = await scrollPosition();
    assert.equal(reader.top, followed.top - 32);
    assert.equal(reader.paused, true);
    await renderChat(liveUpdates(17));
    await waitFrames(40);
    const paused = await scrollPosition();
    assert.ok(paused.bottom > reader.bottom);
    assert.equal(paused.top, reader.top, "live growth must leave the reader in place");
    assert.equal(paused.paused, true);
  });

  test(`a live row growing into view keeps following across two measurements (${reducedMotion})`, async () => {
    await page.emulateMedia({ reducedMotion });
    const height = 550;
    await renderChat(liveUpdates(1), height);
    await waitAtBottom();
    const before = await scrollPosition();
    await page.locator('[data-message-id="reply-7"]').evaluate(
      (row, { height, first, last }) => {
        const previousHeight = row.offsetHeight;
        const measured = new globalThis.ResizeObserver(() => {
          if (row.offsetHeight === previousHeight) return;
          measured.disconnect();
          // The next burst lands after measurement, before the next chase frame.
          globalThis.queueMicrotask(() => globalThis.window.renderChat("chat", height, last));
        });
        measured.observe(row);
        globalThis.window.renderChat("chat", height, first);
      },
      { height, first: liveUpdates(3), last: liveUpdates(22) }
    );
    await page.getByText("Update 22", { exact: true }).waitFor();
    await waitFrames(45);
    const after = await scrollPosition();
    assert.ok(after.bottom - before.bottom > height);
    assert.equal(after.paused, false, "measuring the visible reply must not pause following");
    assert.equal(after.top, after.bottom, "follow both bursts to the painted bottom");
  });
}

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

test("a row expanding above a parked reader keeps the first visible row in place", async () => {
  await renderChat({ messages: history(1, 8) }, 300);
  await waitAtBottom();
  const pane = page.locator("#chat-messages");
  await pane.locator('[data-message-id="user-5"]').evaluate((row) => {
    const pane = row.closest("#chat-messages");
    pane.scrollTop += row.getBoundingClientRect().top - pane.getBoundingClientRect().top + 8;
  });
  await waitFrames(18);
  const before = await rowOffset("user-5");
  assert.ok(
    Math.abs(before + 8) <= 2,
    `expected the first visible row 8 px above the edge, got ${before}`
  );
  assert.equal((await scrollPosition()).paused, true);

  await growRowPastTop("reply-4", 160);
  await waitFrames(18);
  const after = await rowOffset("user-5");
  assert.ok(Math.abs(after - before) <= 2, `first visible row moved from ${before} to ${after}`);
});

test("a reader at the bottom stays there when a row above grows after the chase idles", async () => {
  await renderChat(liveUpdates(1), 300);
  await waitAtBottom();
  const before = await scrollPosition();
  assert.equal(before.top, before.bottom);
  assert.equal(before.paused, false);

  await growRowPastTop("reply-4", 800);
  await waitFrames(18);
  const after = await scrollPosition();
  assert.equal(after.bottom - before.bottom, 800);
  assert.equal(after.top, after.bottom, "stay at the painted bottom after the row grows");
  assert.equal(after.paused, false);
});

async function resizeAtChaseShutdown(change, holdFrames) {
  const props = liveUpdates(1);
  const shrinking = change < 0;
  if (shrinking) props.compactions = [failedCompaction(props.turns[0].turnId)];
  await renderChat(props, 300);
  await waitAtBottom();
  const row = page.locator(`[data-message-id="${shrinking ? "reply-7" : "reply-4"}"]`);
  const initial = await scrollPosition();
  await row.evaluate(
    (row, height) => {
      const spacer = globalThis.document.createElement("div");
      spacer.id = "resizing-content";
      spacer.style.height = `${height}px`;
      row.firstElementChild.append(spacer);
    },
    shrinking ? -change : 0
  );
  if (shrinking) {
    await page.waitForFunction((bottom) => {
      const pane = globalThis.document.getElementById("chat-messages");
      return pane.scrollHeight - pane.clientHeight === bottom;
    }, initial.bottom - change);
    await waitAtBottom();
  }

  const result = await row.evaluate(
    async (row, { change, holdFrames }) => {
      const pane = row.closest("#chat-messages");
      const list = row.parentElement;
      const last = list.lastElementChild;
      const frame = () => new Promise(globalThis.requestAnimationFrame);
      const lastStart = () => last.getBoundingClientRect().top - list.getBoundingClientRect().top;
      const atBottom = pane.scrollTop;
      const committedStart = lastStart();

      // A viewport resize wakes the chase at its target. The row changes between ticks 9 and 10.
      const width = pane.clientWidth;
      await new Promise((done) => {
        const resized = new globalThis.ResizeObserver(() => {
          if (pane.clientWidth === width) return;
          resized.disconnect();
          done();
        });
        resized.observe(pane);
        pane.style.right = "1px";
      });
      for (let i = 0; i < 9; i++) await frame();

      const backwards = [];
      const jump = globalThis.document.querySelector(
        '[aria-label="Scroll to bottom"]'
      ).parentElement;
      let jumpShown = false;
      const watchJump = new globalThis.MutationObserver(() => {
        if (jump.classList.contains("opacity-100")) jumpShown = true;
      });
      watchJump.observe(jump, { attributes: true, attributeFilter: ["class"] });
      const recordWrite = (top) => {
        if (top < pane.scrollTop) backwards.push([pane.scrollTop, top]);
      };
      const scrollTo = pane.scrollTo.bind(pane);
      pane.scrollTo = (...args) => {
        recordWrite(typeof args[0] === "number" ? args[1] : args[0].top);
        scrollTo(...args);
      };
      const scrollTop = Object.getOwnPropertyDescriptor(globalThis.Element.prototype, "scrollTop");
      Object.defineProperty(pane, "scrollTop", {
        configurable: true,
        get: () => scrollTop.get.call(pane),
        set: (value) => {
          recordWrite(value);
          scrollTop.set.call(pane, value);
        },
      });

      // TanStack measures and caches the new size immediately. Hold its notification to React.
      const virtualizer = globalThis.chatVirtualizer;
      const notify = virtualizer.options.onChange;
      let publish;
      virtualizer.options.onChange = (...args) => {
        publish = () => notify(...args);
      };
      const height = row.offsetHeight;
      await new Promise((done) => {
        const measured = new globalThis.ResizeObserver(() => {
          if (row.offsetHeight === height) return;
          measured.disconnect();
          done();
        });
        measured.observe(row);
        globalThis.document.getElementById("resizing-content").style.height =
          `${Math.max(change, 0)}px`;
      });
      for (let i = 0; i < holdFrames; i++) await frame();
      const heldStart = lastStart();
      virtualizer.options.onChange = notify;
      publish();
      for (let i = 0; i < 30; i++) await frame();
      await new Promise((done) => globalThis.setTimeout(done, 0));
      watchJump.disconnect();
      const lastBottom = last.getBoundingClientRect().bottom;
      return {
        atBottom,
        committedStart,
        heldStart,
        afterStart: lastStart(),
        backwards,
        jumpShown,
        clipped:
          lastBottom >
          Math.min(list.getBoundingClientRect().bottom, pane.getBoundingClientRect().bottom) + 1,
      };
    },
    { change, holdFrames }
  );

  assert.equal(
    result.heldStart,
    result.committedStart,
    "the last row stayed at its committed position during the hold"
  );
  assert.equal(
    result.afterStart - result.committedStart,
    change,
    "React committed the new row position"
  );
  assert.deepEqual(result.backwards, [], "no programmatic backward scroll");
  assert.equal(result.jumpShown, false, "the jump button stayed hidden");
  const after = await scrollPosition();
  assert.equal(after.bottom - result.atBottom, change);
  assert.equal(after.top, after.bottom, "follow the bottom after the delayed commit");
  assert.equal(after.paused, false);
  assert.equal(result.clipped, false, "the final row fits inside the list and viewport");
}

test("an above-row measurement on the chase's last idle frame survives a 30-frame React delay", () =>
  resizeAtChaseShutdown(64, 30));

test("a shrinking live row keeps the trailing compaction visible through chase shutdown", () =>
  resizeAtChaseShutdown(-160, 30));

test("a visible row returning to its committed size clears the interim list height", async () => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await renderChat({ messages: history(1, 8) });
  await waitAtBottom();
  const row = page.locator('[data-message-id="reply-8"]');
  const { committed, grown, reverted, visible } = await row.evaluate(async (row) => {
    const pane = row.closest("#chat-messages");
    const list = row.parentElement;
    const virtualizer = globalThis.chatVirtualizer;
    const heights = () => ({ list: list.offsetHeight, measured: virtualizer.getTotalSize() });
    const committed = list.offsetHeight;
    const notify = virtualizer.options.onChange;
    let publish;
    virtualizer.options.onChange = (...args) => {
      publish = () => notify(...args);
    };

    const frame = () => new Promise(globalThis.requestAnimationFrame);
    pane.style.right = "1px"; // Wake the chase with a viewport resize.
    await frame();
    await frame();
    const spacer = globalThis.document.createElement("div");
    spacer.style.height = "64px";
    row.firstElementChild.append(spacer);
    for (let i = 0; i < 30; i++) await frame(); // Let the chase reach the bottom and idle.
    const grown = heights();
    const bounds = row.getBoundingClientRect();
    const view = pane.getBoundingClientRect();
    const visible = bounds.bottom > view.top && bounds.top < view.bottom;
    spacer.remove();
    await frame();
    await frame();
    const reverted = heights();
    virtualizer.options.onChange = notify;
    publish();
    return { committed, grown, reverted, visible };
  });

  assert.ok(visible, "the same row still intersects the viewport when it shrinks");
  assert.deepEqual(grown, { list: committed + 64, measured: committed + 64 });
  assert.deepEqual(reverted, { list: committed + 64, measured: committed });
  await expect
    .poll(async () => {
      await waitFrames(2);
      return row.evaluate((row) => row.parentElement.offsetHeight);
    })
    .toBe(committed);
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
    compactions: [failedCompaction(reply.turn_id)],
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
