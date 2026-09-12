import { beforeEach, describe, expect, it } from "vitest";
import type { ThinkingLevel } from "@/shared/agents";
import {
  useSessionComposerStore,
  sessionComposerActions,
  emptyComposer,
  type ComposerState,
} from "@/features/session/store/sessionComposerStore";

const MODEL = "gpt-test";
const THINKING: ThinkingLevel = "high";

function makeSeed(draft = ""): ComposerState {
  return { ...emptyComposer(MODEL, THINKING), draft };
}

describe("sessionComposerStore", () => {
  beforeEach(() => {
    // Cold-start baseline: in-memory store is empty, no pending drafts.
    useSessionComposerStore.setState({ composers: {}, pendingDrafts: {} });
  });

  describe("seedIfAbsent", () => {
    it("seeds a new composer slice when absent", () => {
      const seed = makeSeed();
      sessionComposerActions.seedIfAbsent("s1", seed);

      expect(useSessionComposerStore.getState().composers["s1"]).toEqual(seed);
    });

    it("is a no-op when the slice already exists (preserves existing state)", () => {
      const first = makeSeed("first draft");
      sessionComposerActions.seedIfAbsent("s1", first);

      const before = useSessionComposerStore.getState().composers["s1"];
      sessionComposerActions.seedIfAbsent("s1", makeSeed("should not overwrite"));

      expect(useSessionComposerStore.getState().composers["s1"]).toBe(before);
      expect(useSessionComposerStore.getState().composers["s1"].draft).toBe("first draft");
    });
  });

  describe("appendDraft on a seeded slice", () => {
    it("writes text to an empty draft with no leading separator", () => {
      sessionComposerActions.seedIfAbsent("s1", makeSeed());
      sessionComposerActions.appendDraft("s1", "hello");

      expect(useSessionComposerStore.getState().composers["s1"].draft).toBe("hello");
    });

    it("appends to a non-empty draft with a blank-line separator", () => {
      sessionComposerActions.seedIfAbsent("s1", makeSeed("existing"));
      sessionComposerActions.appendDraft("s1", "more");

      expect(useSessionComposerStore.getState().composers["s1"].draft).toBe("existing\n\nmore");
    });
  });

  describe("appendDraft before the slice is seeded (cold-start + collapsed panel)", () => {
    it("does not silently drop the draft — it queues into pendingDrafts", () => {
      // Slice is absent (cold start, ChatArea unmounted → seedIfAbsent never ran).
      expect(useSessionComposerStore.getState().composers["s1"]).toBeUndefined();

      sessionComposerActions.appendDraft("s1", "Review these changes");

      // Nothing was dropped: the queue holds the text.
      expect(useSessionComposerStore.getState().pendingDrafts["s1"]).toBe("Review these changes");
      // And no slice was speculatively created (model would be wrong).
      expect(useSessionComposerStore.getState().composers["s1"]).toBeUndefined();
    });

    it("accumulates multiple appends in the pending queue with separators", () => {
      sessionComposerActions.appendDraft("s1", "first");
      sessionComposerActions.appendDraft("s1", "second");
      sessionComposerActions.appendDraft("s1", "third");

      expect(useSessionComposerStore.getState().pendingDrafts["s1"]).toBe(
        "first\n\nsecond\n\nthird"
      );
    });

    it("keeps pending queues for different sessions independent", () => {
      sessionComposerActions.appendDraft("s1", "a");
      sessionComposerActions.appendDraft("s2", "b");

      expect(useSessionComposerStore.getState().pendingDrafts["s1"]).toBe("a");
      expect(useSessionComposerStore.getState().pendingDrafts["s2"]).toBe("b");
    });

    it("routes to the live slice once seeded and stops growing the queue", () => {
      sessionComposerActions.appendDraft("s1", "queued");
      sessionComposerActions.seedIfAbsent("s1", makeSeed());
      // Queue was flushed on seed.
      expect(useSessionComposerStore.getState().pendingDrafts["s1"]).toBeUndefined();

      sessionComposerActions.appendDraft("s1", "live");
      // New append went straight to the slice, not back into the queue.
      expect(useSessionComposerStore.getState().composers["s1"].draft).toBe("queued\n\nlive");
      expect(useSessionComposerStore.getState().pendingDrafts["s1"]).toBeUndefined();
    });
  });

  describe("seedIfAbsent flushes the pending draft", () => {
    it("flushes a queued draft into the freshly-seeded composer", () => {
      sessionComposerActions.appendDraft("s1", "Review these changes");
      sessionComposerActions.seedIfAbsent("s1", makeSeed());

      expect(useSessionComposerStore.getState().composers["s1"].draft).toBe("Review these changes");
    });

    it("clears the pending queue after flushing", () => {
      sessionComposerActions.appendDraft("s1", "Review these changes");
      sessionComposerActions.seedIfAbsent("s1", makeSeed());

      expect(useSessionComposerStore.getState().pendingDrafts["s1"]).toBeUndefined();
    });

    it("appends the queued draft to a non-empty initial draft with a separator", () => {
      // Seed composer is constructed with a non-empty draft (e.g. a restored
      // draft). The pending prompt is appended, not overwriting it.
      const seed = makeSeed("restored draft");
      sessionComposerActions.appendDraft("s1", "Review these changes");
      sessionComposerActions.seedIfAbsent("s1", seed);

      expect(useSessionComposerStore.getState().composers["s1"].draft).toBe(
        "restored draft\n\nReview these changes"
      );
    });

    it("preserves the seeded model/thinking/plan state when flushing", () => {
      sessionComposerActions.appendDraft("s1", "Review these changes");
      sessionComposerActions.seedIfAbsent("s1", makeSeed());

      const slice = useSessionComposerStore.getState().composers["s1"];
      expect(slice.model).toBe(MODEL);
      expect(slice.thinkingLevel).toBe(THINKING);
      expect(slice.planModeEnabled).toBe(false);
      expect(slice.pastedTexts).toEqual([]);
    });

    it("flushes a multi-append pending queue in order", () => {
      sessionComposerActions.appendDraft("s1", "first");
      sessionComposerActions.appendDraft("s1", "second");
      sessionComposerActions.appendDraft("s1", "third");
      sessionComposerActions.seedIfAbsent("s1", makeSeed());

      expect(useSessionComposerStore.getState().composers["s1"].draft).toBe(
        "first\n\nsecond\n\nthird"
      );
    });
  });

  describe("discard", () => {
    it("removes the composer slice", () => {
      sessionComposerActions.seedIfAbsent("s1", makeSeed("draft"));
      sessionComposerActions.discard("s1");

      expect(useSessionComposerStore.getState().composers["s1"]).toBeUndefined();
    });

    it("clears any pending draft queued for that session", () => {
      sessionComposerActions.appendDraft("s1", "queued but tab closed before expand");
      sessionComposerActions.discard("s1");

      expect(useSessionComposerStore.getState().composers["s1"]).toBeUndefined();
      expect(useSessionComposerStore.getState().pendingDrafts["s1"]).toBeUndefined();
    });

    it("is a no-op when neither slice nor pending draft exists", () => {
      expect(() => sessionComposerActions.discard("never-seeded")).not.toThrow();
      expect(useSessionComposerStore.getState().composers["never-seeded"]).toBeUndefined();
      expect(useSessionComposerStore.getState().pendingDrafts["never-seeded"]).toBeUndefined();
    });
  });

  describe("other mutate-based actions still no-op before seeding (no regression)", () => {
    // setDraft, setModel, addPastedText, etc. are user-driven actions that
    // only fire from within a mounted SessionComposer (slice always seeded).
    // They must NOT queue and must NOT create a slice — that would seed with
    // a wrong model. Only the cross-panel text producer (appendDraft) queues.
    it("setDraft does not create a slice or queue", () => {
      sessionComposerActions.setDraft("s1", "should not appear");
      expect(useSessionComposerStore.getState().composers["s1"]).toBeUndefined();
      expect(useSessionComposerStore.getState().pendingDrafts["s1"]).toBeUndefined();
    });

    it("setModel does not create a slice or queue", () => {
      sessionComposerActions.setModel("s1", "claude-test", THINKING);
      expect(useSessionComposerStore.getState().composers["s1"]).toBeUndefined();
    });

    it("addPastedText does not create a slice or queue", () => {
      sessionComposerActions.addPastedText("s1", "pasted");
      expect(useSessionComposerStore.getState().composers["s1"]).toBeUndefined();
    });

    it("clearDraft on a seeded slice clears the draft but keeps the model", () => {
      sessionComposerActions.seedIfAbsent("s1", makeSeed("draft"));
      sessionComposerActions.clearDraft("s1");

      const slice = useSessionComposerStore.getState().composers["s1"];
      expect(slice.draft).toBe("");
      expect(slice.model).toBe(MODEL);
    });
  });

  describe("cold-start scenario: Review Changes with chat panel persisted collapsed", () => {
    // Reproduces the bug report's deterministic reproducer at the store level.
    // 1. Cold start: composer store empty; layout store has
    //    activeChatTabSessionId set + chatPanelCollapsed true (persisted).
    // 2. User clicks "Review Changes" before expanding the chat panel.
    // 3. handleInsertReviewPrompt → appendDraft(sid, REVIEW_CODE).
    // 4. User expands panel → SessionComposer mounts → seedIfAbsent runs.
    // 5. The composer now shows the review prompt on the first render.
    it("the first Review Changes click survives seeding and appears in the composer", () => {
      const sid = "cold-start-session";
      const REVIEW_CODE = "Please review the uncommitted changes.";

      // Cold-start state.
      expect(useSessionComposerStore.getState().composers[sid]).toBeUndefined();
      expect(useSessionComposerStore.getState().pendingDrafts[sid]).toBeUndefined();

      // (2)(3) Click Review Changes while ChatArea is unmounted (panel collapsed).
      // Before the fix this was a silent no-op.
      sessionComposerActions.appendDraft(sid, REVIEW_CODE);

      // The click was NOT dropped — it's queued, awaiting seed.
      expect(useSessionComposerStore.getState().composers[sid]).toBeUndefined();
      expect(useSessionComposerStore.getState().pendingDrafts[sid]).toBe(REVIEW_CODE);

      // (4) User expands the chat panel → SessionComposer mounts → seedIfAbsent
      // runs with the harness-derived model (simulated here by makeSeed()).
      sessionComposerActions.seedIfAbsent(sid, makeSeed());

      // (5) The review prompt is present on the first post-seed render.
      expect(useSessionComposerStore.getState().composers[sid].draft).toBe(REVIEW_CODE);
      expect(useSessionComposerStore.getState().pendingDrafts[sid]).toBeUndefined();

      // No second click needed — the recovery gap is closed.
    });
  });
});
