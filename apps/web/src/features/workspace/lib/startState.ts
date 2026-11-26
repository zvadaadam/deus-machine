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
  | "start_recoverable"
>;

export interface StartWarning {
  message: string;
  preview?: string;
  /** The script's own last lines, as plain text. */
  output?: string;
}

export interface StartStep {
  key: string;
  label: string;
  /** The same step in a narrow place, when the label is too long for one. */
  short?: string;
  state: "done" | "active" | "warning";
  warning?: StartWarning;
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
  failure?: {
    reason: string;
    /** What the tool itself printed. */
    detail: string | null;
    /** Retry and Delete apply: nothing exists for the workspace but its row. */
    recoverable: boolean;
  };
}

/** The local pipeline's stages, in order (backend: services/workspace-init). */
const STAGES = ["fetch", "worktree", "session"] as const;

function completedFetch(issue: InitFetchIssue | null | undefined): StartStep {
  if (!issue) return { key: "fetch", label: "Checked for the latest changes", state: "done" };
  if (issue === "no_origin") return { key: "fetch", label: "No origin to check", state: "done" };
  const why = match(issue)
    .with("offline", () => "We couldn’t reach the remote")
    .with("auth", () => "Git couldn’t sign in to the remote repository")
    .otherwise(() => "We couldn’t get the latest changes");
  return {
    key: "fetch",
    label: "Copy may be out of date",
    state: "warning",
    warning: { message: `${why}, so this copy may be out of date.` },
  };
}

function setupWarning({ state, error_message, error_detail }: StartFields): StartWarning {
  const reason = error_message
    ?.trim()
    .replace(/ (?:View the setup log for details|Run it again)\.$/, "");
  const code = /^Setup exited with code (\d+)\.$/.exec(reason ?? "")?.[1];
  const stopped = reason === "Setup was stopped when Deus closed.";
  const sentence =
    !reason || reason === "Setup exited with code null." ? "Setup didn’t finish." : reason;
  const consequence =
    state === "ready"
      ? "The agent can see the error, and you can keep working."
      : "The workspace can still start.";
  const output = error_detail?.trim() ? error_detail : undefined;
  const lastLine = output
    ?.trimEnd()
    .split(/[\r\n]+/)
    .at(-1)
    ?.trim();
  return {
    message: `${sentence}${/[.!?]$/.test(sentence) ? "" : "."} ${consequence}`,
    preview:
      lastLine ||
      (code
        ? `exit code ${code}`
        : stopped
          ? "Deus closed"
          : reason && sentence.replace(/\.$/, "")),
    output,
  };
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

/** The backend computes this verdict with START_RECOVERABLE in apps/backend/src/db/queries.ts. */
export function canRecoverStart(workspace: Pick<Workspace, "start_recoverable">): boolean {
  return workspace.start_recoverable === true;
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
      failure,
    };
  }

  // The stage being worked on; everything before it is done. A ready workspace
  // has passed them all, whatever its row says (older rows say "done").
  // An older host can still be waiting for setup after making the checkout.
  const stage = workspace.init_stage === "setup" ? "session" : workspace.init_stage;
  const at = phase === "ready" ? STAGES.length : STAGES.indexOf(stage as never);
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
    steps.push(completedFetch(workspace.init_fetch_issue));
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
    .with("failed", () =>
      steps.push({
        key: "setup",
        label: SETUP_FAILED,
        state: "warning",
        warning: phase === "failed" ? undefined : setupWarning(workspace),
      })
    )
    .with("none", () => undefined)
    .exhaustive();

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
      // Setup can be running on the first turn or on a later retry.
      .with("ready", () =>
        active
          ? (active.short ?? active.label)
          : workspace.setup_status === "failed"
            ? SETUP_FAILED
            : null
      )
      .exhaustive(),
    steps,
    failure,
  };
}
