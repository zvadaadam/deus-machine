import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeClient } from "@/platform/ws/runtime-client";
import { queryClient, setActiveQueryClient } from "@/shared/api/queryClient";
import { queryKeys } from "@/shared/api/queryKeys";
import { attachScreenshotToComposer } from "@/features/browser/lib/attachScreenshotToComposer";
import { useHomeComposer, useSessionComposer } from "@/features/session/hooks/useSessionComposer";
import {
  attachImageFiles,
  composerStore,
  composerTarget,
  emptyComposer,
  HOME_COMPOSER_ID,
  sessionComposerActions as actions,
} from "@/features/session/store/sessionComposerStore";

const store = composerStore();
beforeEach(() => {
  store.setState({ composers: {}, pendingContent: {} });
  stubFileReader();
});
afterEach(() => vi.unstubAllGlobals());

const model = "codex-app-server:gpt-6-astra";
const element = { ref: "button-1", tagName: "button", path: "body > button", innerText: "Send" };
const screenshot = {
  file: new File(["screenshot"], "screenshot.png", { type: "image/png" }),
  preview: "data:image/png;base64,c2NyZWVuc2hvdA==",
  type: "image/png",
};

function stubFileReader(read: (done: () => void) => void = (done) => done()) {
  vi.stubGlobal(
    "FileReader",
    class {
      onload!: (event: { target: { result: string } }) => void;
      readAsDataURL() {
        read(() => this.onload({ target: { result: screenshot.preview } }));
      }
    }
  );
}

function memoryStorage(quota = Infinity) {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => {
      if (value.length > quota) throw new DOMException("Storage full", "QuotaExceededError");
      data.set(key, value);
    }),
    removeItem: (key: string) => data.delete(key),
  };
}

// A new renderer gets fresh module state and reads the same window storage.
async function reopen() {
  vi.resetModules();
  return (await import("@/features/session/store/sessionComposerStore")).composerStore();
}

describe("draft storage", () => {
  let storage: ReturnType<typeof memoryStorage>;
  beforeEach(() => {
    storage = memoryStorage();
    vi.stubGlobal("sessionStorage", storage);
  });

  it("keeps a board submission id with its draft and reconciles the accepted prefix once", () => {
    const cache = new RuntimeClient(
      { host: "board", account: "test", grant: "one" },
      { open: vi.fn() }
    ).queryClient;
    const target = composerTarget("board:desk:3", composerStore(cache));
    actions.setDraft(target, "Status?");
    const id = actions.beginSubmission(target, "Status?");
    expect(actions.beginSubmission(target, "Status?")).toBe(id);
    expect(storage.getItem('composer-drafts:["board","test"]')).toContain(id);
    actions.setDraft(target, "Status? More details.");
    expect(actions.finishSubmission(target, id)).toBe(true);
    expect(actions.finishSubmission(target, id)).toBe(false);
    expect(target.store.getState().pendingContent[target.id]?.draft).toBe(" More details.");
    expect(actions.beginSubmission(target, "Status?")).not.toBe(id);
  });

  it("scopes drafts only by the runtime's host and account", () => {
    const cache = (host: string, account: string, grant: string) =>
      new RuntimeClient({ host, account, grant }, { open: vi.fn() }).queryClient;
    const desktop = cache("electron", "electron", "first");
    const local = composerStore(desktop);
    actions.setDraft(composerTarget("home", local), "My Mac");
    desktop.setQueryData(queryKeys.deusCloud.session, { accountId: "cloud-person" });
    expect(composerStore(desktop)).toBe(local);
    desktop.setQueryData(queryKeys.deusCloud.session, { accountId: null });
    expect(composerStore(desktop).getState().pendingContent.home.draft).toBe("My Mac");
    expect(composerStore(cache("electron", "electron", "next"))).toBe(local);
    expect(storage.getItem('composer-drafts:["electron","electron"]')).toContain("My Mac");

    const relay = composerStore(cache("one", "A", "first"));
    actions.setDraft(composerTarget("home", relay), "Account A on one");
    expect(composerStore(cache("one", "A", "renewed"))).toBe(relay);
    expect(composerStore(cache("two", "A", "first")).getState().pendingContent).toEqual({});
    expect(composerStore(cache("one", "B", "first")).getState().pendingContent).toEqual({});
    expect(storage.getItem('composer-drafts:["one","A"]')).toContain("Account A on one");
  });

  it("keeps a hosted account across expiry and renewal and separates accounts sharing a chat", async () => {
    vi.resetModules();
    const { selectRuntime } = await import("@/platform/ws/query-protocol-client");
    const { composerStore } = await import("@/features/session/store/sessionComposerStore");
    vi.stubGlobal(
      "window",
      Object.assign(new EventTarget(), { location: new URL("https://deusmachine.test/") })
    );
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === "deus.cloudDirectWeb" ? "1" : null),
    });
    const now = Date.now();
    const time = vi.spyOn(Date, "now");
    const signIn = (sub: string, exp: number) =>
      storage.setItem("deus_cloud_session", "test." + btoa(JSON.stringify({ sub, exp })) + ".test");
    try {
      signIn("A", (now + 10000) / 1000);
      const a = selectRuntime();
      const drafts = composerStore(a.queryClient);
      actions.setDraft(composerTarget("shared", drafts), "A's notes");
      time.mockReturnValue(now + 20000);
      expect(selectRuntime()).toBe(a);
      signIn("A", (now - 10000) / 1000);
      const expired = selectRuntime();
      expect(expired.identity.account).toBe("A");
      signIn("A", (now + 60000) / 1000);
      const renewed = selectRuntime();
      expect(renewed).not.toBe(expired); // A new bearer already replaces the grant.
      expect(composerStore(renewed.queryClient)).toBe(drafts);
      signIn("B", (now + 60000) / 1000);
      const b = composerStore(selectRuntime().queryClient);
      expect(b.getState().pendingContent).toEqual({});
      actions.setDraft(composerTarget("shared", b), "B's notes");
      expect(storage.getItem('composer-drafts:["web-direct","A"]')).toContain("A's notes");
      expect(storage.getItem('composer-drafts:["web-direct","B"]')).toContain("B's notes");
    } finally {
      time.mockRestore();
    }
  });

  it("restores plain content and lets chat history seed the settings", async () => {
    const target = composerTarget("chat", await reopen());
    actions.seedIfAbsent(target, { ...emptyComposer(model, "high"), planModeEnabled: true });
    actions.setDraft(target, "Please review");
    actions.addPastedText(target, "Notes from the clipboard");
    actions.addFileMention(target, { path: "src/ui.ts", name: "ui.ts" });
    actions.addSkillMention(target, { name: "review" });
    const inspected = { ...element, accessibleName: "Send this message" };
    actions.addInspectedElement(target, inspected);
    const { draft, fileMentions, skillMentions, inspectedElements } =
      target.store.getState().composers.chat;
    const restored = composerTarget("chat", await reopen());
    expect(restored.store.getState().composers).toEqual({});
    const settings = emptyComposer("claude-code:opus", "low");
    actions.seedIfAbsent(restored, settings);
    expect(restored.store.getState().composers.chat).toEqual({
      ...settings,
      draft,
      missingPastedTexts: 1,
      fileMentions,
      skillMentions,
      inspectedElements,
    });
  });

  it("saves only a picture count, and keeps the warning through another save", async () => {
    let target = composerTarget("chat", await reopen());
    await attachImageFiles(target, [screenshot.file, screenshot.file]);
    const raw = storage.setItem.mock.lastCall![1];
    expect(raw).not.toContain(screenshot.file.name);
    expect(raw).not.toContain(screenshot.preview);
    target = composerTarget("chat", await reopen());
    expect(target.store.getState().pendingContent.chat).toMatchObject({
      imageAttachments: [],
      missingPictures: 2,
    });
    actions.setDraft(target, "Slight edit");
    target = composerTarget("chat", await reopen());
    expect(target.store.getState().pendingContent.chat.missingPictures).toBe(2);
    await attachImageFiles(target, [screenshot.file]);
    expect(target.store.getState().pendingContent.chat.missingPictures).toBe(2);
    expect((await reopen()).getState().pendingContent.chat.missingPictures).toBe(3);
  });

  it.each([
    ["First and another thought", " and another thought"],
    ["A new draft", "A new draft"],
  ])("on acknowledgement keeps new text and attachments (%s)", async (typed, remaining) => {
    const target = composerTarget("chat", await reopen());
    actions.setDraft(target, "First");
    actions.addPastedText(target, "Sent paste");
    actions.addFileMention(target, { name: "sent", path: "sent" });
    await attachImageFiles(target, [screenshot.file]);
    const sent = target.store.getState().pendingContent.chat;
    actions.setDraft(target, typed);
    actions.addPastedText(target, "Later paste");
    actions.addFileMention(target, { name: "later", path: "later" });
    const later = new File(["later"], "later.png", { type: "image/png" });
    await attachImageFiles(target, [later]);
    actions.clearSent(target, sent);
    expect(
      target.store.getState().pendingContent.chat.imageAttachments.map((a) => a.file.name)
    ).toEqual([later.name]);
    expect(target.store.getState().pendingContent.chat.pastedTexts).toMatchObject([
      { content: "Later paste" },
    ]);
    expect((await reopen()).getState().pendingContent.chat).toMatchObject({
      draft: remaining,
      pastedTexts: [],
      missingPastedTexts: 1,
      fileMentions: [{ name: "later" }],
      missingPictures: 1,
    });
  });

  it.each([false, true])(
    "saves typing beside a large pasted card, including a move (%s)",
    async (move) => {
      const quota = memoryStorage(1400);
      vi.stubGlobal("sessionStorage", quota);
      vi.resetModules();
      const { sessionComposerActions: edit, composerStore } =
        await import("@/features/session/store/sessionComposerStore");
      const drafts = composerStore();
      edit.setDraft("start", "First");
      const paste = "fixture".repeat(1000);
      edit.addPastedText("start", paste);
      edit.setDraft("start", "Last keystroke");
      if (move) edit.move("start", "chat");
      const id = move ? "chat" : "start";
      expect(drafts.getState().pendingContent[id].pastedTexts[0].content).toBe(paste);
      const kept = (await reopen()).getState().pendingContent;
      expect(kept[id]).toMatchObject({
        draft: "Last keystroke",
        pastedTexts: [],
        missingPastedTexts: 1,
      });
      expect(Object.keys(kept)).toEqual([id]);
      expect(quota.setItem.mock.results.every((result) => result.type === "return")).toBe(true);
    }
  );

  it("drops only the stale draft when saving an acknowledged send fails", async () => {
    const { pendingFirstMessages } = await import("@/features/workspace/store/workspaceStartStore");
    const waiting = { message: "Still waiting", model };
    pendingFirstMessages.set("starting", waiting);
    actions.setDraft(composerTarget("chat", await reopen()), "Ready to send");
    const target = composerTarget("chat", await reopen());
    const sent = target.store.getState().pendingContent.chat;
    expect(sent.draft).toBe("Ready to send");
    storage.setItem.mockImplementationOnce(() => {
      throw new DOMException("Storage full", "QuotaExceededError");
    });
    actions.clearSent(target, sent);
    expect((await reopen()).getState().pendingContent.chat).toBeUndefined();
    const restored = await import("@/features/workspace/store/workspaceStartStore");
    expect(restored.pendingFirstMessages.get("starting")).toEqual(waiting);
  });

  it("saves the latest chat edit when the Home textarea holds more than the quota", async () => {
    vi.stubGlobal("sessionStorage", memoryStorage(150_000));
    const drafts = await reopen();
    const home = composerTarget(HOME_COMPOSER_ID, drafts);
    const chat = composerTarget("chat", drafts);
    const longPrompt = "x".repeat(100_000);
    actions.setDraft(home, longPrompt);
    actions.setDraft(chat, "Earlier note");
    expect((await reopen()).getState().pendingContent[HOME_COMPOSER_ID].draft.length).toBe(
      longPrompt.length
    );

    const paste = longPrompt.repeat(2);
    actions.setDraft(home, paste);
    actions.setDraft(chat, "Latest note");
    expect(drafts.getState().pendingContent[HOME_COMPOSER_ID].draft).toBe(paste);
    const restored = (await reopen()).getState().pendingContent;
    expect(restored.chat.draft).toBe("Latest note");
    expect(restored[HOME_COMPOSER_ID]).toMatchObject({ draft: "", missingPastedTexts: 1 });
  });

  it("restores a partial row beside invalid rows and saves its next edit", async () => {
    const key = "composer-drafts:[null,null]";
    storage.setItem(
      key,
      JSON.stringify({
        version: 0,
        state: {
          pendingContent: {
            notes: { draft: "My notes" },
            invalid: 12,
            invalidDraft: { draft: [] },
            badMention: { fileMentions: [null] },
            badCount: { missingPictures: "2" },
            good: { draft: "Other chat" },
          },
        },
      })
    );
    const drafts = await reopen();
    const target = composerTarget("notes", drafts);
    actions.seedIfAbsent(target, emptyComposer(model, "high"));
    expect(drafts.getState().composers.notes.draft).toBe("My notes");
    actions.setDraft(target, "Edited notes");
    const rows = JSON.parse(storage.getItem(key)!).state.pendingContent;
    expect(Object.keys(rows).sort()).toEqual(["good", "notes"]);
    expect(rows.notes.draft).toBe("Edited notes");
    expect(rows.good.draft).toBe("Other chat");
  });
});

it("reads and edits the Home draft without seeding chat settings", () => {
  vi.stubGlobal("window", Object.assign(new EventTarget(), { HTMLIFrameElement: class {} }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(Object.assign(new EventTarget(), { nodeType: 9 }) as Document);
  let home: ReturnType<typeof useHomeComposer>;
  function HomeDraft() {
    home = useHomeComposer();
    return null;
  }
  try {
    actions.setDraft(HOME_COMPOSER_ID, "A draft from before Home opened");
    act(() => root.render(createElement(HomeDraft)));
    expect(home!.draft).toBe("A draft from before Home opened");
    act(() => home.setDraft("Continue here"));
    expect(store.getState().composers[HOME_COMPOSER_ID]).toBeUndefined();
    const draft = store.getState().pendingContent[HOME_COMPOSER_ID];
    expect(draft.draft).toBe("Continue here");
    expect(draft).not.toHaveProperty("model");
    expect(draft).not.toHaveProperty("thinkingLevel");
    expect(draft).not.toHaveProperty("planModeEnabled");
  } finally {
    act(() => root.unmount());
  }
});

describe("cross-panel staged content", () => {
  it("keeps prompts sent before mount and uses the session's model when it mounts", () => {
    actions.appendDraft("session", "Review these changes");
    actions.appendDraft("session", "Check the tests too");
    const initial = emptyComposer(model, "high");
    initial.draft = "My notes";
    actions.seedIfAbsent("session", initial);
    expect(store.getState().composers.session).toEqual({
      ...initial,
      draft: "My notes\n\nReview these changes\n\nCheck the tests too",
    });
    expect(initial.draft).toBe("My notes");
    expect(store.getState().pendingContent).toEqual({});
    actions.seedIfAbsent("session", emptyComposer("another-model", "low"));
    expect(store.getState().composers.session.model).toBe(initial.model);
  });

  it("keeps an inspection's prompt, target, and screenshot until history seeds the model", async () => {
    actions.appendDraft("session", "Fix this button");
    actions.addInspectedElement("session", element);
    await attachImageFiles("session", [screenshot.file]);
    expect(store.getState().composers.session).toBeUndefined();

    const initial = emptyComposer(model, "xhigh");
    actions.seedIfAbsent("session", initial);
    const composer = store.getState().composers.session;
    expect(composer).toMatchObject({
      model,
      thinkingLevel: "xhigh",
      draft: "Fix this button",
      inspectedElements: [{ ...element, id: expect.any(String) }],
      imageAttachments: [screenshot],
    });
    expect(initial.inspectedElements).toEqual([]);
    expect(initial.imageAttachments).toEqual([]);
    expect(store.getState().pendingContent).toEqual({});

    actions.seedIfAbsent("session", emptyComposer("claude-code:claude-opus-4-7", "low"));
    expect(store.getState().composers.session).toBe(composer);
  });

  it("appends to an already mounted composer and isolates sessions", () => {
    actions.seedIfAbsent("mounted", emptyComposer(model, "high"));
    actions.setDraft("mounted", "Existing text");
    actions.appendDraft("mounted", "Review");
    actions.appendDraft("unmounted", "Other session");
    expect(store.getState().composers.mounted.draft).toBe("Existing text\n\nReview");
    expect(store.getState().pendingContent.unmounted.draft).toBe("Other session");
    expect(store.getState().composers.unmounted).toBeUndefined();
  });

  it.each([false, true])("clears every kind of staged content (seeded: %s)", async (seeded) => {
    const initial = { ...emptyComposer(model, "xhigh"), planModeEnabled: true };
    if (seeded) actions.seedIfAbsent("session", initial);
    actions.setDraft("session", "A draft");
    actions.addPastedText("session", "Pasted notes");
    actions.addInspectedElement("session", element);
    actions.addFileMention("session", { path: "README.md", name: "README.md" });
    actions.addSkillMention("session", { name: "code-review" });
    await attachImageFiles("session", [screenshot.file]);

    const { composers, pendingContent } = store.getState();
    actions.clearSent("session", composers.session ?? pendingContent.session);
    actions.seedIfAbsent("session", initial);
    expect(store.getState().composers.session).toEqual(initial);
    expect(store.getState().pendingContent).toEqual({});
  });

  it("discards queued content on explicit discard", async () => {
    actions.appendDraft("closed", "Must not come back");
    actions.addInspectedElement("closed", element);
    await attachImageFiles("closed", [screenshot.file]);
    actions.discard("closed");
    actions.seedIfAbsent("closed", emptyComposer(model, "high"));
    expect(store.getState().composers.closed).toEqual(emptyComposer(model, "high"));
    expect(store.getState().pendingContent).toEqual({});
  });
});

describe("browser screenshots", () => {
  const previous = queryClient;
  afterEach(() => setActiveQueryClient(previous));

  function switchHost(host: string) {
    const other = new RuntimeClient({ host, account: "A", grant: "next" }, { open: vi.fn() });
    setActiveQueryClient(other.queryClient);
  }

  it("attaches to the requesting chat when the host switches during capture", async () => {
    const target = composerTarget("chat");
    const capture = Promise.withResolvers<string>();
    const attaching = capture.promise.then((url) => attachScreenshotToComposer(target, url));
    switchHost("during-capture");
    capture.resolve(screenshot.preview);
    expect(await attaching).toBe(true);
    expect(composerStore().getState().pendingContent).toEqual({});
    expect(store.getState().pendingContent.chat.imageAttachments).toHaveLength(1);
  });

  it.each(["move", "discard"])("finishes on the original host after %s", async (action) => {
    let finish!: () => void;
    stubFileReader((done) => {
      finish = done;
    });
    actions.seedIfAbsent("workspace", emptyComposer(model, "high"));
    const reading = attachScreenshotToComposer(composerTarget("workspace"), screenshot.preview);
    if (action === "move") actions.move("workspace", "chat");
    else actions.discard("workspace");
    switchHost("other-" + action);
    finish();
    const attached = await reading;
    expect(composerStore().getState().pendingContent).toEqual({});
    expect(attached).toBe(action === "move");
    expect(store.getState().composers.workspace).toBeUndefined();
    expect(store.getState().pendingContent.workspace).toBeUndefined();
    expect(store.getState().composers.chat?.imageAttachments.length ?? 0).toBe(
      action === "move" ? 1 : 0
    );
  });
});

describe("move: a workspace's start composer hands over to its first chat", () => {
  it("does nothing when the start page had no composer", () => {
    const chat = { ...emptyComposer(model, "high"), draft: "Mine" };
    actions.seedIfAbsent("chat", chat);
    actions.move("workspace", "chat");
    expect(store.getState().composers.chat).toEqual(chat);
    expect(store.getState().composers.workspace).toBeUndefined();
  });

  it("gives a chat with no composer the start composer's whole state", async () => {
    actions.seedIfAbsent("workspace", emptyComposer(model, "xhigh"));
    actions.togglePlanMode("workspace");
    actions.setDraft("workspace", "Also add tests");
    await attachImageFiles("workspace", [screenshot.file]);
    actions.move("workspace", "chat");
    expect(store.getState().composers.chat).toMatchObject({
      model,
      thinkingLevel: "xhigh",
      planModeEnabled: true,
      draft: "Also add tests",
      imageAttachments: [screenshot],
    });
    expect(store.getState().composers.workspace).toBeUndefined();
  });

  it("keeps an existing chat composer's settings and adds the start composer's content", () => {
    actions.seedIfAbsent("chat", { ...emptyComposer(model, "low"), draft: "Mine" });
    actions.seedIfAbsent("workspace", emptyComposer("claude-code:claude-opus-4-7", "high"));
    actions.setDraft("workspace", "Also add tests");
    actions.addInspectedElement("workspace", element);
    actions.move("workspace", "chat");
    expect(store.getState().composers.chat).toMatchObject({
      model,
      thinkingLevel: "low",
      planModeEnabled: false,
      draft: "Mine\n\nAlso add tests",
      inspectedElements: [{ ...element, id: expect.any(String) }],
    });
    expect(store.getState().composers.workspace).toBeUndefined();
  });

  it("keeps content staged for the chat before it had a composer", () => {
    actions.appendDraft("chat", "Review these changes");
    actions.seedIfAbsent("workspace", emptyComposer(model, "high"));
    actions.setDraft("workspace", "Also add tests");
    actions.move("workspace", "chat");
    expect(store.getState().composers.chat).toMatchObject({
      model,
      draft: "Also add tests\n\nReview these changes",
    });
    expect(store.getState().pendingContent).toEqual({});
  });

  it("moves only what was typed to a chat spoken to elsewhere: its history sets the agent", () => {
    const claude = "claude-code:opus";
    actions.seedIfAbsent("workspace", emptyComposer(claude, "high"));
    actions.setDraft("workspace", "Also add tests");
    actions.move("workspace", "chat", { settings: false });

    expect(store.getState().composers.chat).toBeUndefined();
    expect(store.getState().composers.workspace).toBeUndefined();
    // The chat's composer is seeded from its history (a Codex chat), and gets the text.
    actions.seedIfAbsent("chat", emptyComposer(model, "medium"));
    expect(store.getState().composers.chat).toMatchObject({ model, draft: "Also add tests" });
  });
});

describe("a reopened chat's thinking level", () => {
  it("seeds the chat; a model switch still falls back to the person's default", () => {
    let composer: ReturnType<typeof useSessionComposer> | undefined;
    const Probe = () => {
      composer = useSessionComposer("chat", {
        initialModel: "claude-code:haiku",
        initialThinking: "off",
        defaultThinking: "medium",
      });
      return null;
    };
    renderToStaticMarkup(createElement(Probe));
    expect(composer?.thinkingLevel).toBe("off");
    // What the hook's seed effect does in the browser.
    actions.seedIfAbsent("chat", emptyComposer("claude-code:haiku", "off"));
    composer!.setModel("claude-code:sonnet", ["low", "medium", "high"]);
    expect(store.getState().composers.chat.thinkingLevel).toBe("medium");
  });
});

describe("a model change before the model list is live", () => {
  it("keeps the chat's level, which is fitted only once the destination's live list is in", async () => {
    const { composerThinking } = await import("@shared/models");
    actions.seedIfAbsent("chat", emptyComposer("codex-app-server:gpt-6.2-sol", "ultra"));
    // Switched before the live list: no levels to fit to, so nothing is written.
    actions.setModel("chat", "codex-app-server:gpt-6.2-astra", undefined, "high");
    const composer = store.getState().composers.chat!;
    expect(composer.model).toBe("codex-app-server:gpt-6.2-astra");
    expect(composer.thinkingLevel).toBe("ultra");
    // The live list arrives and offers the level: it stays.
    expect(composerThinking(composer.thinkingLevel, ["low", "high", "max", "ultra"], "high")).toBe(
      "ultra"
    );
    // Had it been fitted to a catalog lacking it, it would have been lost.
    actions.setModel(
      "chat",
      "codex-app-server:gpt-5.5",
      ["low", "medium", "high", "xhigh"],
      "high"
    );
    expect(store.getState().composers.chat!.thinkingLevel).toBe("xhigh");
  });
});
