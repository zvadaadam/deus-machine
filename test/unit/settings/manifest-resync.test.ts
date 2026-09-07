/**
 * resolveManifestResync — defense-in-depth coverage for the manifest editor's
 * manifestData-resync effect.
 *
 * The editor's `useEffect([manifestData])` re-syncs its local draft from the
 * cached manifest. When that cache change is the post-save reflection of what
 * we just persisted (the cache was written synchronously by
 * useSaveRepoManifest.onSuccess), the resync MUST NOT clobber in-flight
 * keystrokes the user typed during the save round-trip — the saved
 * manifest was a snapshot at `mutate()` time and does NOT include them.
 * Instead, recompute `isDirty` against the saved manifest so the user can
 * immediately re-save any edits that landed while the save was in flight.
 *
 * These are pure-function unit tests (no React) of the decision logic that
 * EnvironmentSection.tsx invokes inside its resync effect.
 */

import { describe, expect, it } from "vitest";
import { resolveManifestResync } from "@/features/settings/ui/sections/manifest-resync";
import {
  EMPTY_DRAFT,
  EMPTY_TASK,
  manifestToDraft,
  draftToManifest,
  type ManifestDraft,
} from "@/features/settings/ui/sections/manifest-draft";
import type { ManifestResponse, NormalizedTask } from "@shared/types/manifest";

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: 1, ...overrides };
}

function manifestData(manifest: Record<string, unknown> | null): ManifestResponse {
  return { manifest, tasks: [] };
}

function draftWithSetup(setupScript: string): ManifestDraft {
  return { ...EMPTY_DRAFT, setupScript };
}

/**
 * Build a "saved manifest" the same way `handleSave` does — by calling
 * `draftToManifest` on the editor's draft at the moment the user clicked Save.
 * This puts `saved` in the canonical `draftToManifest` output form, so the
 * round-trip `draftToManifest(manifestToDraft(saved)) === saved` holds. Tests
 * rely on this property to assert `isDirty=false` cleanly. (Real-world saves
 * persist exactly this `draftToManifest(draft)` value, so this matches the
 * field scenario.)
 */
function savedFromDraft(draft: ManifestDraft): Record<string, unknown> {
  return draftToManifest(draft);
}

const TASK_DEV: NormalizedTask = {
  name: "dev",
  command: "bun run dev",
  description: null,
  icon: "terminal",
  persistent: false,
  mode: "nonconcurrent",
  depends: [],
  env: {},
};

describe("resolveManifestResync — noop", () => {
  it("returns noop when no manifestData exists (no repo selected, initial mount)", () => {
    expect(
      resolveManifestResync({
        manifestData: undefined,
        savedManifest: null,
        draft: EMPTY_DRAFT,
      })
    ).toEqual({ kind: "noop" });
  });

  it("returns noop when manifestData is undefined even if a save marker is set", () => {
    // Save succeeded but the cached entry was undefined (e.g., another
    // observer unmounted and gcTime cleared it). Don't resync to nothing.
    expect(
      resolveManifestResync({
        manifestData: undefined,
        savedManifest: manifest({ scripts: { setup: "bun install" } }),
        draft: manifestToDraft(manifest({ scripts: { setup: "bun install" } })),
      })
    ).toEqual({ kind: "noop" });
  });
});

describe("resolveManifestResync — resync (initial load / repo switch / external invalidation)", () => {
  it("resyncs the draft from the manifest when no save is in flight", () => {
    const m = manifest({ scripts: { setup: "bun install", run: "bun run dev" } });
    expect(
      resolveManifestResync({
        manifestData: manifestData(m),
        savedManifest: null,
        draft: EMPTY_DRAFT,
      })
    ).toEqual({ kind: "resync", draft: manifestToDraft(m) });
  });

  it("resyncs to an empty draft when the server has no manifest (manifest: null) and no save is in flight", () => {
    expect(
      resolveManifestResync({
        manifestData: manifestData(null),
        savedManifest: null,
        draft: draftWithSetup("user typed but not saved"),
      })
    ).toEqual({ kind: "resync", draft: manifestToDraft(null) });
  });

  it("falls through to resync when the save-marker is set but the cached manifest does NOT match it (external collaborator edit during our save)", () => {
    // We saved M1; the cache was then overwritten by an external refetch
    // with M2 (someone else edited the manifest). Home into the externally
    // changed manifest and drop the in-flight edit. (Same surface as the
    // pre-fix behavior for external conflict — not a regression.)
    const ours = savedFromDraft(draftWithSetup("bun install"));
    const theirs = savedFromDraft(draftWithSetup("echo extern"));

    const action = resolveManifestResync({
      manifestData: manifestData(theirs),
      savedManifest: ours,
      draft: manifestToDraft(ours),
    });
    expect(action).toEqual({ kind: "resync", draft: manifestToDraft(theirs) });
  });
});

describe("resolveManifestResync — preserve-after-save (keystrokes during save round-trip)", () => {
  it("suppresses the clobber and reports isDirty=true when the draft has unflushed edits beyond the saved manifest", () => {
    // User clicked Save (snapshot includes setup="bun install"), then typed
    // an extra char while the save was in flight. The cache setQueryData'd the
    // snapshot, so manifestData.manifest === the saved manifest, and the
    // draft has the unflushed keystroke.
    const base = draftWithSetup("bun install");
    const saved = savedFromDraft(base);
    const draft = { ...base, setupScript: "bun install && echo extra" };

    const action = resolveManifestResync({
      manifestData: manifestData(saved),
      savedManifest: saved,
      draft,
    });
    expect(action).toEqual({ kind: "preserve-after-save", isDirty: true });
  });

  it("suppresses the clobber and reports isDirty=false when the draft matches the saved manifest (no keystrokes during save)", () => {
    const base = draftWithSetup("bun install");
    const saved = savedFromDraft(base);

    const action = resolveManifestResync({
      manifestData: manifestData(saved),
      savedManifest: saved,
      draft: base,
    });
    expect(action).toEqual({ kind: "preserve-after-save", isDirty: false });
  });

  it("reports isDirty=false when the keystroke made during save was a net no-op (typed then removed) — draftToManifest equals the saved manifest", () => {
    // The user typed a char into the Setup script then deleted it during the
    // save. draftToManifest(draft) yields the saved manifest, so isDirty=false.
    const base = draftWithSetup("bun install");
    const saved = savedFromDraft(base);

    const action = resolveManifestResync({
      manifestData: manifestData(saved),
      savedManifest: saved,
      draft: base,
    });
    expect(action).toEqual({ kind: "preserve-after-save", isDirty: false });
  });

  it("reports isDirty=false when the keystroke changed an unflushed field (e.g., env var with empty key — stripped by draftToManifest)", () => {
    // User typed into an env var value field whose key is empty. draftToManifest
    // strips it (only env vars with a non-empty key are emitted), so the draft
    // round-trips to the saved manifest.
    const base = draftWithSetup("bun install");
    const saved = savedFromDraft(base);
    const draft = { ...base, env: [{ id: "ev1", key: "", value: "ignored value" }] };

    const action = resolveManifestResync({
      manifestData: manifestData(saved),
      savedManifest: saved,
      draft,
    });
    expect(action).toEqual({ kind: "preserve-after-save", isDirty: false });
  });

  it("reports isDirty=true when the keystroke added a fully-formed task during the save", () => {
    const base = draftWithSetup("bun install");
    const saved = savedFromDraft(base);
    const draft: ManifestDraft = {
      ...base,
      tasks: [{ ...EMPTY_TASK, id: "t1", name: "dev", command: "bun run dev" }],
    };

    const action = resolveManifestResync({
      manifestData: manifestData(saved),
      savedManifest: saved,
      draft,
    });
    expect(action).toEqual({ kind: "preserve-after-save", isDirty: true });
  });

  it("recognizes a structurally-equal cached manifest without reference identity (deep-equal via canonicalized form)", () => {
    // The cache reflection might (in a future code path) be a fresh fetch
    // deep-equal to (but not reference-equal to) the saved manifest.
    const saved = savedFromDraft(draftWithSetup("bun install"));
    const cached: Record<string, unknown> = JSON.parse(JSON.stringify(saved));

    const action = resolveManifestResync({
      manifestData: manifestData(cached),
      savedManifest: saved,
      draft: manifestToDraft(saved),
    });
    expect(action).toEqual({ kind: "preserve-after-save", isDirty: false });
  });

  it("preserves tasks-only vs manifest divergence: a draft that round-trips to the saved manifest reports dirty=false even when draft fields differ", () => {
    // The draft may have a different `requires[].id`/`env[].id` (UUIDs) than
    // the form it was loaded from, but draftToManifest strips those IDs, so
    // the serializable manifest matches the saved one.
    const saved = manifest({
      requires: { node: ">=22" },
      env: { NODE_ENV: "test" },
    });
    const draft = manifestToDraft(saved);
    // IDs are regenerated by manifestToDraft — they're inconsequential. Don't
    // touch anything else; the round-trip must equal `saved`.
    const action = resolveManifestResync({
      manifestData: manifestData(saved),
      savedManifest: saved,
      draft,
    });
    expect(action).toEqual({ kind: "preserve-after-save", isDirty: false });
  });

  it("round-trips a draft with a saved task list back to the saved manifest (isDirty=false, no clobber)", () => {
    const saved = manifest({
      tasks: { dev: "bun run dev" },
    });
    const draft = manifestToDraft(saved);
    expect(draft.tasks.map((t) => t.name)).toEqual(["dev"]);

    const action = resolveManifestResync({
      manifestData: manifestData(saved),
      savedManifest: saved,
      draft,
    });
    expect(action).toEqual({ kind: "preserve-after-save", isDirty: false });
  });

  it("distinguishes an edit to an existing task during the save (isDirty=true)", () => {
    const saved = manifest({ tasks: { dev: "bun run dev" } });
    const draft = manifestToDraft(saved);
    // User changed the task command while the save was in flight.
    draft.tasks[0].command = "bun run dev --turbo";

    const action = resolveManifestResync({
      manifestData: manifestData(saved),
      savedManifest: saved,
      draft,
    });
    expect(action).toEqual({ kind: "preserve-after-save", isDirty: true });
  });

  it("resolves real server-normalized tasks vs draft tasks correctly (saved manifest with non-trivial tasks)", () => {
    // Even when the cached `tasks` are server-normalized (e.g., from a
    // fetchManifest response), the resync decision uses `manifest`, not
    // `tasks` — those are for downstream consumers, not the editor draft.
    const base = draftWithSetup("bun install");
    const saved = savedFromDraft(base);
    const data: ManifestResponse = {
      manifest: saved,
      tasks: [TASK_DEV],
    };

    // No save marker — initial load: resync.
    expect(
      resolveManifestResync({
        manifestData: data,
        savedManifest: null,
        draft: EMPTY_DRAFT,
      })
    ).toEqual({ kind: "resync", draft: manifestToDraft(saved) });

    // Save marker matches manifest: preserve (tasks are preserved by the
    // setQueryData callback, not by the resync decision).
    expect(
      resolveManifestResync({
        manifestData: data,
        savedManifest: saved,
        draft: base,
      })
    ).toEqual({ kind: "preserve-after-save", isDirty: false });
  });
});
