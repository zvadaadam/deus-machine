/**
 * The composer's Cloud control, as rules: what it says, and what choosing an
 * organization in its menu does. With one organization (or no list) it is the
 * switch alone, "Cloud"; with several the label is also a menu of them, and names
 * the organization only while the cloud is on.
 */
import { match } from "ts-pattern";
import type { OrganizationRowState } from "@/features/sidebar/lib/location";

export interface CloudControlWords {
  /** The text beside the glyph. */
  label: string;
  /** The label opens the organizations menu. */
  chooser: boolean;
  /** The switch's accessible name. */
  switchName: string;
  tooltip: string;
}

export function cloudControlWords({
  several,
  location,
  organizationName,
  lockedReason = null,
}: {
  /** The account has more than one organization. */
  several: boolean;
  location: "local" | "cloud";
  /** The composer's organization; null with no list. */
  organizationName: string | null;
  /** Why the switch cannot be turned off (the project is not on this computer). */
  lockedReason?: string | null;
}): CloudControlWords {
  const named = several && location === "cloud" && organizationName ? organizationName : null;
  return {
    label: named ?? "Cloud",
    chooser: several,
    switchName: named ? `Run on a cloud computer in ${named}` : "Run on a cloud computer",
    tooltip: lockedReason
      ? lockedReason
      : location === "cloud"
        ? named
          ? `Runs on a cloud computer in ${named} (clones the repo's origin)`
          : "Runs on a cloud computer (clones the repo's origin)"
        : "Off — runs in a git worktree on this Mac",
  };
}

/**
 * Why a project can only run in the cloud: it has no folder on this computer.
 * Null for a project with one (or none chosen). The composer's Cloud switch is
 * then on and cannot be turned off, and says this in its tooltip.
 */
export function cloudOnlyReason(
  repo: { name: string; root_path: string | null } | null
): string | null {
  if (!repo || repo.root_path) return null;
  return `${repo.name} is not on this Mac`;
}

/**
 * Why a project that runs only in the cloud cannot start now: the cloud cannot be
 * used (signed out, or the composer's organization is not set up here). Null when
 * it can, or when the project is on this computer.
 */
export function cloudOnlySendBlock({
  repo,
  cloudReady,
  organizationName,
}: {
  repo: { name: string; root_path: string | null } | null;
  /** The composer's organization is ready (or, with no list, the cloud is available). */
  cloudReady: boolean | undefined;
  organizationName: string | null;
}): string | null {
  if (!cloudOnlyReason(repo) || cloudReady === true) return null;
  const name = repo!.name;
  return organizationName
    ? `${name} is not on this Mac, so it runs in the cloud, and ${organizationName} is not set up on this computer. Set it up to start it there.`
    : `${name} is not on this Mac, so it runs in the cloud. Sign in to Deus Cloud to start it.`;
}

/**
 * An organization chosen in the composer's menu: a ready one becomes the composer's
 * and the cloud goes on there, through the access gate; one not set up runs the
 * setup (the header menu's Set up); one setting up, or not set up where it cannot be,
 * does nothing.
 */
export function chooseComposerOrganization(
  organization: { id: string; state: OrganizationRowState },
  actions: {
    setOrganization: (id: string) => void;
    requestCloud: (id: string) => void;
    setUp: (id: string) => void;
  }
): void {
  match(organization.state)
    .with("ready", () => {
      actions.setOrganization(organization.id);
      actions.requestCloud(organization.id);
    })
    .with("set-up", () => actions.setUp(organization.id))
    .with("setting-up", "unavailable", () => undefined)
    .exhaustive();
}
