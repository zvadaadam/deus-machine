import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { useSessionComposer } from "@/features/session/hooks/useSessionComposer";
import {
  emptyComposer,
  sessionComposerActions as actions,
  useSessionComposerStore as store,
} from "@/features/session/store/sessionComposerStore";
import type { ImageAttachment } from "@/features/session/lib/imageAttachments";

beforeEach(() => store.setState({ composers: {}, pendingContent: {} }));

const model = "codex-app-server:gpt-6-astra";
const element = { ref: "button-1", tagName: "button", path: "body > button", innerText: "Send" };
const screenshot: ImageAttachment = {
  id: "screenshot",
  file: new File(["screenshot"], "screenshot.png", { type: "image/png" }),
  preview: "data:image/png;base64,c2NyZWVuc2hvdA==",
  type: "image/png",
};

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

    actions.clearContent("session");
    actions.seedIfAbsent("session", initial);
    expect(store.getState().composers.session).toEqual(initial);
    expect(store.getState().pendingContent).toEqual({});
  });

  it("discards queued content when its tab is closed", () => {
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
