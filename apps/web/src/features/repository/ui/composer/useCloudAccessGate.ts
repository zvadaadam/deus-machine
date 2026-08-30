/**
 * useCloudAccessGate — the cloud-access gate behind the composer's Cloud toggle,
 * lifted out of CloudToggle so the toggle stays a toggle.
 *
 * Owns the whole "can this repo run in the cloud?" state machine in ONE place.
 * A single `intent` (the repo the user asked to run in the cloud) drives it:
 * - while the verdict is still loading the intent is HELD — cloud is NOT
 *   selected, so a fast toggle+submit can't create a doomed workspace before the
 *   verdict arrives;
 * - `ok` / `unknown` → select cloud;
 * - `needs_grant` → open the Grant modal (derived from intent + verdict).
 * App installs finish out-of-band on github.com with no callback, so while an
 * intent is live the access query re-checks on the window-focus event (see
 * useCloudRepoAccess) — event-driven, not a poll — and returning from GitHub
 * continues into cloud on its own. The intent is pinned to its repo, so
 * switching the picker mid-flow drops it rather than acting on the wrong repo.
 */
import { useEffect, useState } from "react";
import { useCloudRepoAccess } from "./useCloudRepoAccess";

export interface CloudAccessGate {
  /** True while the Grant modal should be shown. */
  grantOpen: boolean;
  /** `owner/name` the open modal is prompting for (for its copy). */
  slug: string | null;
  onOpenChange: (open: boolean) => void;
  /**
   * Call when the user flips the toggle. Returns true if it intercepted — the
   * caller must then NOT switch to cloud (the gate drives the transition once
   * the verdict resolves).
   */
  interceptCloud: (on: boolean) => boolean;
}

export function useCloudAccessGate({
  repoId,
  signedIn,
  location,
  onLocationChange,
}: {
  repoId: string | null | undefined;
  signedIn: boolean;
  location: "local" | "cloud";
  onLocationChange: (location: "local" | "cloud") => void;
}): CloudAccessGate {
  // The cloud intent: the repo the user asked to run in the cloud. Non-null =
  // we're resolving it (holding, prompting, or continuing). Pinned to its repo
  // so a mid-flow picker switch drops it rather than acting on the wrong repo.
  const [intent, setIntent] = useState<{ repoId: string } | null>(null);
  const access = useCloudRepoAccess(repoId, { enabled: signedIn, watch: intent !== null });
  const status = access.data?.status;

  // Resolve the intent as its verdict arrives (or drop it if the repo changed).
  useEffect(() => {
    if (!intent) return;
    if (intent.repoId !== repoId) {
      setIntent(null); // composer moved to another repo
    } else if (status === "ok" || status === "unknown") {
      setIntent(null);
      onLocationChange("cloud"); // cloneable (App/public) or unknowable — allow
    }
    // status === "needs_grant" → keep intent; grantOpen (below) shows the modal.
    // status === undefined → keep intent; still loading (pending).
  }, [intent, repoId, status, onLocationChange]);

  // Keep the invariant: location is "cloud" ONLY while the CURRENT repo's verdict
  // is a confirmed go (ok / unknown). Anything else with cloud selected — the
  // picker switched to an uncached repo (status undefined) or access was revoked
  // mid-session (needs_grant) — reverts to local and re-arms the intent, so a
  // stale cloud selection can't be submitted before the new verdict lands.
  useEffect(() => {
    if (signedIn && location === "cloud" && repoId && status !== "ok" && status !== "unknown") {
      onLocationChange("local");
      setIntent({ repoId });
    }
  }, [signedIn, location, status, repoId, onLocationChange]);

  const grantOpen = intent !== null && status === "needs_grant";

  return {
    grantOpen,
    slug: grantOpen ? (access.data?.slug ?? intent?.repoId ?? null) : null,
    onOpenChange: (open) => {
      if (!open) setIntent(null);
    },
    interceptCloud: (on) => {
      if (!on) {
        setIntent(null); // toggling off cancels any pending / grant intent
        return false;
      }
      if (!repoId) return false;
      // Only a resolved "go" verdict enables cloud immediately. needs_grant OR a
      // still-loading verdict HOLDS the intent (no premature cloud); the resolve
      // effect continues once the verdict arrives.
      if (status === "ok" || status === "unknown") return false;
      setIntent({ repoId });
      return true;
    },
  };
}
