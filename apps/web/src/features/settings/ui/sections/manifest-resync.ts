/**
 * State-machine logic for the manifest editor's manifestData-resync effect.
 *
 * Extracted from EnvironmentSection so it can be unit-tested in isolation
 * (apps/web has no DOM test runner; the editor itself can't be rendered in
 * the existing vitest config). See EnvironmentSection.tsx for usage.
 */

import type { ManifestResponse } from "@shared/types/manifest";
import { draftToManifest, manifestToDraft, type ManifestDraft } from "./manifest-draft";

/** What the resync effect should do for a given manifestData update. */
export type ManifestResyncAction =
  | { kind: "noop" }
  | { kind: "resync"; draft: ManifestDraft }
  | { kind: "preserve-after-save"; isDirty: boolean };

/**
 * Decide what the manifest editor's `manifestData`-resync effect should do.
 *
 * The editor re-syncs its local draft to the cached manifest on every
 * `manifestData` change. When that change is the post-save reflection of
 * what we just persisted (the cache was written synchronously by
 * `useSaveRepoManifest.onSuccess`), the resync MUST NOT clobber in-flight
 * keystrokes the user typed during the save round-trip — the saved
 * manifest was a snapshot taken at `mutate()` time and does NOT include
 * them. Instead, recompute `isDirty` against the saved manifest so the
 * user can immediately re-save any edits that landed while the save was
 * in flight.
 *
 * The two cached objects are compared by `JSON.stringify` rather than by
 * reference: the cache write happens at the call site (so the value stored
 * matches the value the editor passed in), but comparing the canonicalized
 * form keeps the check robust if a future code path writes a freshly-fetched
 * copy that is deep-equal but not reference-equal to the saved manifest.
 */
export function resolveManifestResync(args: {
  manifestData: ManifestResponse | undefined;
  savedManifest: Record<string, unknown> | null;
  draft: ManifestDraft;
}): ManifestResyncAction {
  if (!args.manifestData) return { kind: "noop" };
  if (
    args.savedManifest &&
    JSON.stringify(args.savedManifest) === JSON.stringify(args.manifestData.manifest)
  ) {
    const unflushed = draftToManifest(args.draft);
    return {
      kind: "preserve-after-save",
      isDirty: JSON.stringify(unflushed) !== JSON.stringify(args.savedManifest),
    };
  }
  return { kind: "resync", draft: manifestToDraft(args.manifestData.manifest) };
}
