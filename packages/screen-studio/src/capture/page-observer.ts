/**
 * Watch what happens in a browser tab, whatever drives it.
 *
 * Any tool that operates a page — agent-browser, Playwright, Puppeteer, a
 * person — ends up dispatching real input to it. Passive, capture-phase
 * listeners see that input with the target's exact box at that instant, so a
 * browser recording knows where each action happened without the tool
 * reporting anything. Typed text is never read: only a character count.
 */
import type { EventInput } from "../bundle/schema.js";
import type { ActionInput } from "../recorder.js";
import type { CdpClient } from "./cdp.js";

const BINDING = "__screenStudioObserve";
/** Shorter frame gaps are ordinary jank, not a hidden page. */
const MIN_UNSEEN_MS = 500;
const UNSEEN = "hidden tab, hidden view or minimized window";

/** Runs in the page (top frame only; frame-relative boxes would be wrong). */
const PAGE_SCRIPT = `(() => {
  if (window !== window.top || window.__screenStudioObserver) return;
  const send = (payload) => { try { window.${BINDING}(JSON.stringify(payload)); } catch {} };
  const at = (e) => Math.round(performance.timeOrigin + e.timeStamp);
  const origin = (e) => (e.composedPath && e.composedPath()[0]) || e.target;
  const ACTIONABLE = "button,a,input,select,textarea,summary,label,[role=button],[role=link],[role=tab],[role=checkbox],[role=radio],[role=switch],[role=menuitem],[role=option],[contenteditable=true]";
  const describe = (node) => {
    const el = node instanceof Element ? (node.closest(ACTIONABLE) || node) : null;
    if (!el) return {};
    const r = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    const named = /^(button|a|summary|label)$/.test(tag) || el.getAttribute("role");
    const label = (el.getAttribute("aria-label") || (named ? el.textContent : "") || el.getAttribute("placeholder") || el.getAttribute("name") || "")
      .trim().replace(/\\s+/g, " ").slice(0, 60);
    return { rect: { x: r.x, y: r.y, width: r.width, height: r.height }, label, tag };
  };
  const listeners = [];
  const on = (type, fn) => {
    const handler = (e) => { if (e.isTrusted) fn(e); };
    addEventListener(type, handler, { capture: true, passive: true });
    listeners.push([type, handler]);
  };
  on("pointerdown", (e) => send({ t: "down", at: at(e), x: e.clientX, y: e.clientY, touch: e.pointerType === "touch", ...describe(origin(e)) }));
  on("click", (e) => send({ t: "click", at: at(e), x: e.clientX, y: e.clientY, ...describe(origin(e)) }));
  on("contextmenu", (e) => send({ t: "context", at: at(e), x: e.clientX, y: e.clientY, ...describe(origin(e)) }));
  on("input", (e) => {
    const el = origin(e);
    const value = el && "value" in el ? el.value : el && el.textContent;
    send({ t: "input", at: at(e), chars: String(value || "").length, ...describe(el) });
  });
  const KEYS = ["Enter", "Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown"];
  on("keydown", (e) => {
    const chord = e.metaKey || e.ctrlKey || e.altKey;
    if (!KEYS.includes(e.key) && !chord) return;
    const mods = [e.metaKey && "Meta", e.ctrlKey && "Control", e.altKey && "Alt", e.shiftKey && "Shift"].filter(Boolean);
    send({ t: "key", at: at(e), key: chord ? [...mods, e.key.length === 1 ? e.key.toUpperCase() : e.key].join("+") : e.key });
  });
  let lastScroll = 0;
  on("scroll", (e) => {
    if (e.timeStamp - lastScroll < 100) return;
    lastScroll = e.timeStamp;
    const el = origin(e);
    send({ t: "scroll", at: at(e), ...(el instanceof Element ? describe(el) : {}) });
  });
  // A page that is not painted (hidden tab, hidden <webview>, minimized
  // window) runs no animation frames, while its timers still fire, throttled
  // to about one a second. A gap between frames that timers ran through was
  // not painted; a gap they could not run in was a busy main thread, which
  // the recording shows as it was. The first frame after the gap ends it.
  let lastFrame = Date.now(), lastTick = lastFrame, freeTicks = 0, live = true;
  const hidden = () => Date.now() - lastFrame > ${MIN_UNSEEN_MS} && freeTicks >= 2;
  const frame = () => {
    if (hidden()) send({ t: "unseen", at: lastFrame, endAt: Date.now() });
    lastFrame = Date.now();
    freeTicks = 0;
    if (live) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  const beat = setInterval(() => { const now = Date.now(); if (now - lastTick < 1200) freeTicks++; lastTick = now; }, 250);
  window.__screenStudioObserver = { off: () => {
    live = false; clearInterval(beat);
    for (const [t, h] of listeners) removeEventListener(t, h, { capture: true });
    delete window.__screenStudioObserver;
    return hidden() ? lastFrame : null;
  } };
})()`;

interface Observed {
  t: "down" | "click" | "context" | "input" | "key" | "scroll" | "unseen";
  at: number;
  endAt?: number;
  x?: number;
  y?: number;
  touch?: boolean;
  rect?: { x: number; y: number; width: number; height: number };
  label?: string;
  tag?: string;
  chars?: number;
  key?: string;
}

const TYPING_GAP_MS = 1500;
const SCROLL_GAP_MS = 600;

const sameBox = (a?: Observed["rect"], b?: Observed["rect"]) =>
  !!a &&
  !!b &&
  Math.abs(a.x - b.x) < 2 &&
  Math.abs(a.y - b.y) < 2 &&
  Math.abs(a.width - b.width) < 2;

/**
 * Install the observer on a connected page and turn its raw input into
 * actions. Returns a function that removes it and flushes what is pending.
 */
export async function observePage(
  client: CdpClient,
  emitEvent: (event: EventInput) => void
): Promise<() => Promise<void>> {
  const emit = (action: ActionInput) => emitEvent({ kind: "action", ...action } as EventInput);
  let pressed: Observed | null = null;
  let typing: { first: Observed; last: Observed } | null = null;
  let scrolling: { first: Observed; last: Observed } | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flushTyping = () => {
    if (!typing) return;
    const { first, last } = typing;
    typing = null;
    emit({
      type: "type",
      at: first.at,
      endAt: last.at,
      ...(last.rect ? { rect: last.rect } : {}),
      label: `${last.label ? `${last.label}: ` : ""}${last.chars ?? 0} chars`,
    });
  };
  const flushScrolling = () => {
    if (!scrolling) return;
    const { first, last } = scrolling;
    scrolling = null;
    emit({
      type: "scroll",
      at: first.at,
      endAt: last.at,
      ...(first.label ? { label: first.label } : {}),
    });
  };
  const flushAll = () => {
    flushTyping();
    flushScrolling();
  };
  const armFlush = () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flushAll, Math.max(TYPING_GAP_MS, SCROLL_GAP_MS));
  };

  const pointerAction = (e: Observed, type: ActionInput["type"]) => {
    const start = pressed && e.at - pressed.at < 1500 ? pressed.at : e.at;
    pressed = null;
    emit({
      type,
      at: start,
      endAt: e.at,
      ...(e.rect && e.rect.width > 0 ? { rect: e.rect } : {}),
      ...(e.x !== undefined && e.y !== undefined ? { point: { x: e.x, y: e.y } } : {}),
      ...(e.label ? { label: e.label } : {}),
    });
  };

  const receive = (e: Observed) => {
    switch (e.t) {
      case "unseen":
        if (e.endAt !== undefined && e.endAt > e.at) {
          emitEvent({ kind: "unseen", at: e.at, endAt: e.endAt, reason: UNSEEN });
        }
        break;
      case "down":
        flushAll();
        pressed = e;
        break;
      case "click":
        flushAll();
        pointerAction(e, pressed?.touch ? "tap" : "click");
        break;
      case "context":
        flushAll();
        pointerAction(e, "right-click");
        break;
      case "input":
        flushScrolling();
        if (typing && sameBox(typing.last.rect, e.rect) && e.at - typing.last.at < TYPING_GAP_MS) {
          typing.last = e;
        } else {
          flushTyping();
          typing = { first: e, last: e };
        }
        armFlush();
        break;
      case "key":
        flushAll();
        emit({ type: "key", at: e.at, endAt: e.at, label: e.key ?? "key" });
        break;
      case "scroll":
        flushTyping();
        if (scrolling && e.at - scrolling.last.at < SCROLL_GAP_MS) scrolling.last = e;
        else {
          flushScrolling();
          scrolling = { first: e, last: e };
        }
        armFlush();
        break;
    }
  };

  client.on("Runtime.bindingCalled", (params) => {
    if (params.name !== BINDING) return;
    try {
      receive(JSON.parse(String(params.payload)) as Observed);
    } catch {
      // a malformed payload is dropped, never fatal
    }
  });
  const navigated = (url: unknown) => {
    if (typeof url !== "string" || !/^https?:/.test(url)) return;
    flushAll();
    emit({ type: "navigate", at: Date.now(), endAt: Date.now(), url });
  };
  client.on("Page.frameNavigated", (params) => {
    const frame = params.frame as { parentId?: string; url?: string } | undefined;
    if (frame && !frame.parentId) navigated(frame.url);
  });
  client.on("Page.navigatedWithinDocument", (params) => navigated(params.url));

  await client.send("Runtime.enable");
  await client.send("Runtime.addBinding", { name: BINDING });
  const { identifier } = await client.send<{ identifier: string }>(
    "Page.addScriptToEvaluateOnNewDocument",
    { source: PAGE_SCRIPT }
  );
  await client.send("Runtime.evaluate", { expression: PAGE_SCRIPT });

  return async () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushAll();
    const stoppedAt = Date.now();
    const [off] = await Promise.all([
      client
        .send<{
          result?: { value?: unknown };
        }>(
          "Runtime.evaluate",
          { expression: "window.__screenStudioObserver?.off()", returnByValue: true },
          2_000
        )
        .catch(() => null),
      client
        .send("Page.removeScriptToEvaluateOnNewDocument", { identifier }, 2_000)
        .catch(() => {}),
      client.send("Runtime.removeBinding", { name: BINDING }, 2_000).catch(() => {}),
    ]);
    // Still hidden when the recording stopped: the gap runs to the end.
    const hiddenSince = off?.result?.value;
    if (typeof hiddenSince === "number" && hiddenSince < stoppedAt) {
      emitEvent({ kind: "unseen", at: hiddenSince, endAt: stoppedAt, reason: UNSEEN });
    }
  };
}
