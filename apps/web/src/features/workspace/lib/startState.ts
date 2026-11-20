/**
 * A workspace's start, as the chat tells it: the steps that ran, what went
 * wrong without stopping it (warnings), and what stopped it (a failure).
 *
 * A pure reading of the workspace row, so it is the same on every client and
 * after a reload. The chat renders it with the line cloud provisioning uses
 * (session/ui/EnvGroup), so a local checkout and a cloud computer read alike.
 */
import { match } from "ts-pattern";
import type { InitFetchIssue } from "@shared/enums";
import type { Workspace } from "@shared/types/workspace";

type StartFields = Pick<
  Workspace,
  | "kind"
  | "state"
  | "init_stage"
  | "init_fetch_issue"
  | "setup_status"
  | "error_message"
  | "error_detail"
  | "provider_workspace_id"
  | "current_session_id"
>;

export interface StartStep {
  key: string;
  label: string;
  /** The same step in a narrow place, when the label is too long for one. */
  short?: string;
  state: "done" | "active" | "warning";
}

/** The setup script's two states, worded once for every place that shows them. */
export const SETUP_RUNNING = "Running setup…";
export const SETUP_FAILED = "Setup failed";
/** A cloud workspace before its computer is up: the start page and the chat's provisioning line alike. */
export const CLOUD_STARTING = "Starting a cloud computer…";

export interface WorkspaceStart {
  phase: "starting" | "ready" | "failed";
  /** It runs on a cloud computer, not this one. */
  cloud: boolean;
  /** The one line that says where things stand; the steps are listed under it. */
  summary: string;
  /**
   * A few words for a narrow place (the sidebar row): what it is doing, or
   * what went wrong. Null when there is nothing to say: it is simply ready.
   */
  brief: string | null;
  /** What ran, in order. Empty for a cloud workspace: its computer tells its own story. */
  steps: StartStep[];
  /** What went wrong without stopping the start. */
  warnings: string[];
  failure?: {
    reason: string;
    /** What the tool itself printed. */
    detail: string | null;
    /** Retry and Delete apply: nothing exists for the workspace but its row. */
    recoverable: boolean;
  };
}

/** The local pipeline's stages, in order (backend: services/workspace-init). */
const STAGES = ["fetch", "worktree", "setup", "session"] as const;

/** Why the workspace may be behind: it started without the remote's latest. */
function fetchIssueNotice(issue: InitFetchIssue): string {
  const why = match(issue)
    .with("offline", () => "Couldn't reach the remote repository")
    .with("auth", () => "Git couldn't sign in to the remote repository")
    .with("failed", () => "Couldn't get the latest from the remote repository")
    .exhaustive();
  return `${why}, so this starts from what is already on this computer. It may be behind.`;
}

/**
 * A workspace has somewhere to work once it has a chat: a local workspace gets
 * its first chat when its checkout exists, a cloud one when its computer is
 * being provisioned. Before that there is no branch to open a pull request
 * from and nothing for the tools to show.
 */
export function hasCheckout(workspace: Pick<Workspace, "current_session_id">): boolean {
  return !!workspace.current_session_id;
}

/** It failed before there was anywhere to work: the page is the failure, nothing else. */
export function failedToStart(workspace: Pick<Workspace, "state" | "current_session_id">): boolean {
  return workspace.state === "error" && !hasCheckout(workspace);
}

/**
 * A failed start can be retried or deleted while the row is all there is: no
 * chat, and no cloud computer (that one is the platform's to wake or remove).
 * The backend applies the same rule.
 */
export function canRecoverStart(
  workspace: Pick<Workspace, "state" | "kind" | "provider_workspace_id" | "current_session_id">
): boolean {
  return (
    failedToStart(workspace) && (workspace.kind !== "cloud" || !workspace.provider_workspace_id)
  );
}

export function workspaceStart(workspace: StartFields): WorkspaceStart {
  const phase =
    workspace.state === "error" ? "failed" : workspace.state === "ready" ? "ready" : "starting";
  const failure =
    phase === "failed"
      ? {
          reason:
            workspace.error_message ?? "Something went wrong before this workspace was ready.",
          detail: workspace.error_detail ?? null,
          recoverable: canRecoverStart(workspace),
        }
      : undefined;

  if (workspace.kind === "cloud") {
    return {
      phase,
      cloud: true,
      summary: match(phase)
        .with("starting", () => CLOUD_STARTING)
        .with("ready", () => "Computer ready")
        .with("failed", () => "Workspace didn't start")
        .exhaustive(),
      brief: match(phase)
        .with("starting", () => "Starting…")
        .with("ready", () => null)
        .with("failed", () => "Computer failed")
        .exhaustive(),
      steps: [],
      warnings: [],
      failure,
    };
  }

  // The stage being worked on; everything before it is done. A ready workspace
  // has passed them all, whatever its row says (older rows say "done").
  const at = phase === "ready" ? STAGES.length : STAGES.indexOf(workspace.init_stage as never);
  const reached = (stage: (typeof STAGES)[number]) => at > STAGES.indexOf(stage);
  const working = (stage: (typeof STAGES)[number]) =>
    phase === "starting" && at === STAGES.indexOf(stage);

  const steps: StartStep[] = [];
  if (working("fetch")) {
    steps.push({
      key: "fetch",
      label: "Getting the latest changes…",
      short: "Updating…",
      state: "active",
    });
  } else if (reached("fetch")) {
    steps.push(
      workspace.init_fetch_issue
        ? { key: "fetch", label: "Started without the latest changes", state: "warning" }
        : { key: "fetch", label: "Checked for the latest changes", state: "done" }
    );
  }
  if (working("worktree")) {
    steps.push({
      key: "worktree",
      label: "Making a safe copy…",
      short: "Copying…",
      state: "active",
    });
  } else if (reached("worktree")) {
    steps.push({ key: "worktree", label: "Made a safe copy", state: "done" });
  }
  // A project with no setup script has no setup step to show.
  match(workspace.setup_status)
    .with("running", () => steps.push({ key: "setup", label: SETUP_RUNNING, state: "active" }))
    .with("completed", () => steps.push({ key: "setup", label: "Ran setup", state: "done" }))
    .with("failed", () => steps.push({ key: "setup", label: SETUP_FAILED, state: "warning" }))
    .with("none", () => undefined)
    .exhaustive();

  const warnings: string[] = [];
  if (workspace.init_fetch_issue) warnings.push(fetchIssueNotice(workspace.init_fetch_issue));
  if (phase !== "failed" && workspace.setup_status === "failed") {
    const reason = `The setup script failed, so this workspace started without it.${workspace.error_message ? ` ${workspace.error_message}` : ""}`;
    warnings.push([reason, workspace.error_detail].filter(Boolean).join("\n"));
  }

  const active = steps.find((step) => step.state === "active");
  return {
    phase,
    cloud: false,
    summary: match(phase)
      .with("starting", () => "Setting up workspace…")
      .with("ready", () => "Workspace ready")
      .with("failed", () => "Workspace didn't start")
      .exhaustive(),
    brief: match(phase)
      .with("failed", () => "Failed")
      .with("starting", () => active?.short ?? active?.label ?? "Starting…")
      // Ready, but its setup script is running again, or failed.
      .with("ready", () =>
        active
          ? (active.short ?? active.label)
          : workspace.setup_status === "failed"
            ? SETUP_FAILED
            : null
      )
      .exhaustive(),
    steps,
    warnings,
    failure,
  };
}
