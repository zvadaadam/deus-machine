/**
 * Can a cloud sandbox clone a given repo right now?
 *
 * A tokenless sandbox clones public repos anonymously and private repos only
 * with a GitHub App installation token. This verdict — shared by the composer's
 * proactive "Grant repository access" modal and the create-time safety net —
 * answers that one question so the preview the user sees can never disagree
 * with what provisioning decides.
 */
export type CloudRepoAccessStatus =
  /** App covers the repo (a token mints), or the repo is public — cloud can clone it. */
  | "ok"
  /** Private repo the App provably does NOT cover — prompt to install/grant it. */
  | "needs_grant"
  /** Not signed in, non-GitHub origin, or a transient miss — never a grant prompt. */
  | "unknown";

export interface CloudRepoAccess {
  status: CloudRepoAccessStatus;
  /** `owner/name` when the origin is GitHub (for the modal copy), else null. */
  slug: string | null;
}
