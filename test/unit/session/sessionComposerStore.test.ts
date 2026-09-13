import { beforeEach, describe, expect, it } from "vitest";
import {
  emptyComposer,
  sessionComposerActions as actions,
  useSessionComposerStore as store,
} from "@/features/session/store/sessionComposerStore";

beforeEach(() => store.setState({ composers: {}, pendingDrafts: {} }));

describe("cross-panel drafts", () => {
  it("keeps prompts sent before mount and uses the session's model when it mounts", () => {
    actions.appendDraft("session", "Review these changes");
    actions.appendDraft("session", "Check the tests too");
    const initial = emptyComposer("codex/gpt-6-astra", "high");
    initial.draft = "My notes";
    actions.seedIfAbsent("session", initial);
    expect(store.getState().composers.session).toEqual({
      ...initial,
      draft: "My notes\n\nReview these changes\n\nCheck the tests too",
    });
    expect(initial.draft).toBe("My notes");
    expect(store.getState().pendingDrafts).toEqual({});
    actions.seedIfAbsent("session", emptyComposer("another-model", "low"));
    expect(store.getState().composers.session.model).toBe(initial.model);
  });

  it("appends to an already mounted composer and isolates sessions", () => {
    actions.seedIfAbsent("mounted", emptyComposer("model", "high"));
    actions.setDraft("mounted", "Existing text");
    actions.appendDraft("mounted", "Review");
    actions.appendDraft("unmounted", "Other session");
    expect(store.getState().composers.mounted.draft).toBe("Existing text\n\nReview");
    expect(store.getState().pendingDrafts).toEqual({ unmounted: "Other session" });
  });

  it("discards queued content when its tab is closed", () => {
    actions.appendDraft("closed", "Must not come back");
    actions.discard("closed");
    actions.seedIfAbsent("closed", emptyComposer("model", "high"));
    expect(store.getState().composers.closed.draft).toBe("");
    expect(store.getState().pendingDrafts).toEqual({});
  });
});
