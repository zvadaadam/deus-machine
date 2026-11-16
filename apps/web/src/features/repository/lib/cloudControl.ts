/**
 * The composer's Cloud control, as rules: what it says, and what choosing an
 * organization in its menu does. With one organization (or no list) it is the
 * switch alone, "Cloud"; with several the label is also a menu of them, and names
 * the organization only while the cloud is on.
 */
import { match } from "ts-pattern";
import type { CloudRepoAccessStatus } from "@shared/types/cloud-access";
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
 * and the cloud goes on there, through the access gate. One not set up runs the setup
 * (the header menu's Set up) and becomes the composer's at once, so the switch is off
 * (this computer) while it is not ready; the cloud is asked for there and goes on once
 * it is ready and its verdict is a go (`heldCloudIntent`). One setting up, or not set
 * up where it cannot be, does nothing.
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
    .with("set-up", () => {
      // The setup first: it is running by the time the gate looks at the request.
      actions.setUp(organization.id);
      actions.setOrganization(organization.id);
      actions.requestCloud(organization.id);
    })
    .with("setting-up", "unavailable", () => undefined)
    .exhaustive();
}

/**
 * A cloud request the access gate holds, as what it reads changes: `go` turns the
 * switch on, `end` drops the request, `hold` keeps waiting. It goes only where the
 * composer's organization is ready, and, with a project chosen, its access verdict is
 * a go (`ok`, or `unknown`: never block on uncertainty). It ends once the organization
 * is known not to be ready and no setup is running, so a request never turns the
 * cloud on by itself later.
 */
export function heldCloudIntent({
  forRepo,
  status,
  cloudReady,
  settingUp,
}: {
  /** The request is for a chosen project (else for the organization alone). */
  forRepo: boolean;
  /** The project's access verdict; undefined while it loads. */
  status: CloudRepoAccessStatus | undefined;
  /** The composer's organization is ready (or, with no list, the cloud available). */
  cloudReady: boolean | undefined;
  /** A cloud setup is running on this computer. */
  settingUp: boolean;
}): "go" | "hold" | "end" {
  if (cloudReady !== true) return cloudReady === false && !settingUp ? "end" : "hold";
  if (!forRepo) return "go";
  return status === "ok" || status === "unknown" ? "go" : "hold";
}
