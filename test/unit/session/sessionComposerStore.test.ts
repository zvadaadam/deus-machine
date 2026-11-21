import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RuntimeClient } from "@/platform/ws/runtime-client";
import { queryKeys } from "@/shared/api/queryKeys";
import { useSessionComposer } from "@/features/session/hooks/useSessionComposer";
import {
  attachImageFiles,
  composerStore,
  composerTarget,
  emptyComposer,
  sessionComposerActions as actions,
  useSessionComposerStore as store,
} from "@/features/session/store/sessionComposerStore";
import type { ImageAttachment } from "@/features/session/lib/imageAttachments";

beforeEach(() => composerStore().setState({ composers: {}, pendingContent: {} }));

const model = "codex-app-server:gpt-6-astra";
const element = { ref: "button-1", tagName: "button", path: "body > button", innerText: "Send" };
const screenshot: ImageAttachment = {
  id: "screenshot",
  file: new File(["screenshot"], "screenshot.png", { type: "image/png" }),
  preview: "data:image/png;base64,c2NyZWVuc2hvdA==",
  type: "image/png",
};

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
  afterEach(() => vi.unstubAllGlobals());

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
    const cloud = composerStore(cache("web-direct", "web-direct", "first"));
    actions.setDraft(composerTarget("hosted-chat", cloud), "Resume here");
    expect(storage.getItem('composer-drafts:["web-direct","web-direct"]')).toContain("Resume here");
  });

  it("restores plain content and lets chat history seed the settings", async () => {
    const target = composerTarget("chat", await reopen());
    actions.seedIfAbsent(target, { ...emptyComposer(model, "high"), planModeEnabled: true });
    actions.setDraft(target, "Please review");
    actions.addPastedText(target, "Notes from the clipboard");
    actions.addFileMention(target, { path: "src/ui.ts", name: "ui.ts" });
    actions.addSkillMention(target, { name: "review" });
    actions.addInspectedElement(target, element);
    const { draft, pastedTexts, fileMentions, skillMentions, inspectedElements } =
      target.store.getState().composers.chat;
    const restored = composerTarget("chat", await reopen());
    expect(restored.store.getState().composers).toEqual({});
    const settings = emptyComposer("claude-code:opus", "low");
    actions.seedIfAbsent(restored, settings);
    expect(restored.store.getState().composers.chat).toEqual({
      ...settings,
      draft,
      pastedTexts,
      fileMentions,
      skillMentions,
      inspectedElements,
    });
  });

  it("writes when draft content changes, including a keystroke, and skips model and plan changes", async () => {
    const target = composerTarget("chat", await reopen());
    actions.seedIfAbsent(target, emptyComposer(model, "high"));
    actions.setDraft(target, "A".repeat(64 * 1024));
    actions.setThinkingLevel(target, "low");
    actions.togglePlanMode(target);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    actions.setDraft(target, "A".repeat(64 * 1024) + "B");
    expect(storage.setItem).toHaveBeenCalledTimes(2);
  });

  it("saves only a picture count, and keeps the warning through another save", async () => {
    let target = composerTarget("chat", await reopen());
    actions.addImageAttachments(target, [screenshot, { ...screenshot, id: "another" }]);
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
    actions.addImageAttachments(target, [screenshot]);
    expect(target.store.getState().pendingContent.chat.missingPictures).toBe(0);
    expect((await reopen()).getState().pendingContent.chat.missingPictures).toBe(1);
  });

  it.each([
    ["First and another thought", " and another thought"],
    ["A new draft", "A new draft"],
  ])("on acknowledgement keeps new text and attachments (%s)", async (typed, remaining) => {
    const target = composerTarget("chat", await reopen());
    actions.setDraft(target, "First");
    actions.addPastedText(target, "Sent paste");
    actions.addFileMention(target, { name: "sent", path: "sent" });
    actions.addImageAttachments(target, [screenshot]);
    const sent = target.store.getState().pendingContent.chat;
    actions.setDraft(target, typed);
    actions.addPastedText(target, "Later paste");
    actions.addFileMention(target, { name: "later", path: "later" });
    const later = { ...screenshot, id: "later-picture" };
    actions.addImageAttachments(target, [later]);
    actions.clearSent(target, sent);
    expect(target.store.getState().pendingContent.chat.imageAttachments).toEqual([later]);
    expect((await reopen()).getState().pendingContent.chat).toMatchObject({
      draft: remaining,
      pastedTexts: [{ content: "Later paste" }],
      fileMentions: [{ name: "later" }],
      missingPictures: 1,
    });
  });

  it("keeps an oversized edit in memory while smaller writes and removals reach storage", async () => {
    const quota = memoryStorage(1400);
    vi.stubGlobal("sessionStorage", quota);
    const drafts = await reopen();
    const large = composerTarget("large", drafts);
    const small = composerTarget("small", drafts);
    const sent = composerTarget("sent", drafts);
    actions.setDraft(large, "Last saved");
    actions.setDraft(small, "Small");
    actions.setDraft(sent, "Sending");
    const paste = "x".repeat(3000);
    drafts.setState((state) => {
      state.pendingContent.large.pastedTexts.push({ id: "paste", content: paste });
      state.pendingContent.small.draft = "Edited in the same update";
    });
    const rejected = () => quota.setItem.mock.results.filter((r) => r.type === "throw").length;
    const failures = rejected();
    expect(failures).toBeGreaterThan(0);
    expect((await reopen()).getState().pendingContent.small.draft).toBe(
      "Edited in the same update"
    );
    actions.setDraft(small, "Small edit");
    actions.clearSent(sent, drafts.getState().pendingContent.sent);
    const saved = (await reopen()).getState().pendingContent;
    expect(saved.large).toMatchObject({ draft: "Last saved", pastedTexts: [] });
    expect(saved.small.draft).toBe("Small edit");
    expect(saved.sent).toBeUndefined();
    const staged = drafts.getState().pendingContent.large.pastedTexts[0];
    expect(staged.content).toBe(paste);
    expect(rejected()).toBe(failures);
    actions.removePastedText(large, staged.id);
    actions.setDraft(large, "Fits again");
    expect((await reopen()).getState().pendingContent.large.draft).toBe("Fits again");
  });
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

  it("keeps an inspection's prompt, target, and screenshot until history seeds the model", () => {
    actions.appendDraft("session", "Fix this button");
    actions.addInspectedElement("session", element);
    actions.addImageAttachments("session", [screenshot]);
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

  it.each([false, true])("clears every kind of staged content (seeded: %s)", (seeded) => {
    const initial = { ...emptyComposer(model, "xhigh"), planModeEnabled: true };
    if (seeded) actions.seedIfAbsent("session", initial);
    actions.setDraft("session", "A draft");
    actions.addPastedText("session", "Pasted notes");
    actions.addInspectedElement("session", element);
    actions.addFileMention("session", { path: "README.md", name: "README.md" });
    actions.addSkillMention("session", { name: "code-review" });
    actions.addImageAttachments("session", [screenshot]);

    const { composers, pendingContent } = store.getState();
    actions.clearSent("session", composers.session ?? pendingContent.session);
    actions.seedIfAbsent("session", initial);
    expect(store.getState().composers.session).toEqual(initial);
    expect(store.getState().pendingContent).toEqual({});
  });

  it("discards queued content on explicit discard", () => {
    actions.appendDraft("closed", "Must not come back");
    actions.addInspectedElement("closed", element);
    actions.addImageAttachments("closed", [screenshot]);
    actions.discard("closed");
    actions.seedIfAbsent("closed", emptyComposer(model, "high"));
    expect(store.getState().composers.closed).toEqual(emptyComposer(model, "high"));
    expect(store.getState().pendingContent).toEqual({});
  });
});

describe("move: a workspace's start composer hands over to its first chat", () => {
  it.each(["move", "discard"])(
    "handles a file read still in progress during %s",
    async (action) => {
      let finish!: () => void;
      vi.stubGlobal(
        "FileReader",
        class {
          onload!: (event: { target: { result: string } }) => void;
          readAsDataURL() {
            finish = () => this.onload({ target: { result: screenshot.preview } });
          }
        }
      );
      try {
        actions.seedIfAbsent("workspace", emptyComposer(model, "high"));
        const reading = attachImageFiles("workspace", [screenshot.file]);
        if (action === "move") actions.move("workspace", "chat");
        else actions.discard("workspace");
        finish();
        await reading;
        expect(store.getState().composers.workspace).toBeUndefined();
        expect(store.getState().pendingContent.workspace).toBeUndefined();
        expect(store.getState().composers.chat?.imageAttachments.length ?? 0).toBe(
          action === "move" ? 1 : 0
        );
      } finally {
        vi.unstubAllGlobals();
      }
    }
  );

  it("does nothing when the start page had no composer", () => {
    const chat = { ...emptyComposer(model, "high"), draft: "Mine" };
    actions.seedIfAbsent("chat", chat);
    actions.move("workspace", "chat");
    expect(store.getState().composers.chat).toEqual(chat);
    expect(store.getState().composers.workspace).toBeUndefined();
  });

  it("gives a chat with no composer the start composer's whole state", () => {
    actions.seedIfAbsent("workspace", emptyComposer(model, "xhigh"));
    actions.togglePlanMode("workspace");
    actions.setDraft("workspace", "Also add tests");
    actions.addImageAttachments("workspace", [screenshot]);
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
