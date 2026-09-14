import { beforeEach, describe, expect, it } from "vitest";
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
