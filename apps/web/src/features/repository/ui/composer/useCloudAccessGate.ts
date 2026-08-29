/**
 * useCloudAccessGate — the cloud-access gate behind the composer's Cloud toggle,
 * lifted out of CloudToggle so the toggle stays a toggle.
 *
 * Owns the whole "can this repo run in the cloud?" state machine in ONE place:
 * it probes access (only while signed in), raises the Grant modal when a private
 * repo the GitHub App doesn't cover is chosen, and — because App installs
 * complete out-of-band on github.com with no callback — polls while the modal is
 * open so returning from GitHub continues into cloud on its own. The grant
 * intent is pinned to the repo it was raised for, so switching the composer's
 * repo picker mid-flow neither auto-continues nor prompts for the wrong repo.
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
   * Call when the user flips the toggle. Returns true if it intercepted (the
   * repo needs a grant) — the caller must then NOT switch to cloud.
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
  // The grant intent: which repo we prompted for + its slug for the copy.
  // Non-null == the modal is open. Pinning the repo is what stops a mid-flow
  // picker switch from auto-continuing (or prompting) for the wrong repo.
  const [grant, setGrant] = useState<{ repoId: string; slug: string } | null>(null);
  const access = useCloudRepoAccess(repoId, { enabled: signedIn, watch: grant !== null });
  const status = access.data?.status;

  // Resolve an open prompt: the composer moved to another repo → drop the stale
  // prompt; access granted for the pinned repo → continue into cloud.
  useEffect(() => {
    if (!grant) return;
    if (grant.repoId !== repoId) {
      setGrant(null);
    } else if (status === "ok") {
      setGrant(null);
      onLocationChange("cloud");
    }
  }, [grant, repoId, status, onLocationChange]);

  // A cloud selection that turns out un-cloneable (the probe resolved after an
  // optimistic flip, or access was revoked mid-session) → revert to local and
  // prompt. `needs_grant` is the only definitive-no verdict, so this never
  // fires on an "unknown" blip.
  useEffect(() => {
    if (location === "cloud" && status === "needs_grant" && repoId && access.data) {
      onLocationChange("local");
      setGrant({ repoId, slug: access.data.slug ?? repoId });
    }
  }, [location, status, repoId, access.data, onLocationChange]);

  return {
    grantOpen: grant !== null,
    slug: grant?.slug ?? null,
    onOpenChange: (open) => {
      if (!open) setGrant(null);
    },
    interceptCloud: (on) => {
      if (on && status === "needs_grant" && repoId) {
        setGrant({ repoId, slug: access.data?.slug ?? repoId });
        return true;
      }
      return false;
    },
  };
}
