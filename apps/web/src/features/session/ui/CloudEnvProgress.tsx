/**
 * Cloud environment progress — the Cursor-style setup story in the chat.
 *
 * Renders the ephemeral `cloudEnvironment` stream (agnt workspace.state
 * passthrough) as an environment line in the transcript (EnvGroup, the line a
 * local workspace's start uses too): while in flight its steps are listed
 * under "Starting a cloud computer…" (or "Waking computer"); once running
 * they fold behind "Computer ready"; paused, stopped or failed it is one
 * line. Groups are spliced into the timeline chronologically
 * (chatTimeline.insertCloudEnv), so a wake reads: your message → setup lines →
 * the reply. Nothing is persisted — a refresh clears the story.
 */

import { useEffect, useMemo, type ComponentProps } from "react";
import { CLOUD_STARTING } from "@/features/workspace/lib/startState";
import { EnvGroup, type EnvLine } from "./EnvGroup";
import {
  useCloudEnvStore,
  ensureCloudEnvSubscription,
  type CloudEnvEntry,
} from "../store/cloudEnvStore";

/** Live entries for the timeline build. Stable EMPTY when none. */
const NO_ENTRIES: CloudEnvEntry[] = [];
export function useCloudEnvEntries(workspaceId?: string | null): CloudEnvEntry[] {
  useEffect(() => {
    ensureCloudEnvSubscription();
  }, []);
  return useCloudEnvStore(
    (s) => (workspaceId ? s.byWorkspace[workspaceId] : undefined) ?? NO_ENTRIES
  );
}

// Deliberately an OPEN dictionary (string keys): steps are an open platform
// vocabulary, looked up with arbitrary runtime strings and humanized on miss.
const STEP_LABELS: Record<string, string> = {
  initializing: "Initializing computer",
  installing_packages: "Installing packages",
  syncing_env_vars: "Syncing environment",
  configuring_git_auth: "Configuring git access",
  setting_up_browser: "Setting up browser",
  cloning_repository: "Cloning repository",
  running_pre_clone_setup: "Running pre-clone setup",
  running_setup_commands: "Running setup commands",
  restoring_session_state: "Restoring session state",
};

function stepLabel(step: string | null): string {
  if (!step) return "Provisioning computer";
  const known = STEP_LABELS[step];
  if (known) return known;
  const words = step.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

type EnvProps = ComponentProps<typeof EnvGroup>;

/** The statuses a computer rests in; every other one is on its way to one of them. */
const SETTLED = new Set(["running", "paused", "stopped", "error"]);

export function buildGroup(entries: CloudEnvEntry[]): EnvProps | null {
  const latest = entries[entries.length - 1];
  if (!latest) return null;
  const line = (title: string, state: EnvProps["state"]): EnvProps => ({
    title,
    where: "cloud",
    state,
  });

  // Settled-bad states replace the story: old provisioning steps are stale
  // noise next to "the computer is paused".
  if (latest.status === "paused")
    return line("Computer paused — it wakes on your next message", "asleep");
  if (latest.status === "stopped")
    return line(
      latest.reason ? `Computer stopped — ${latest.reason}` : "Computer stopped",
      "asleep"
    );
  if (latest.status === "error")
    return line(latest.reason ? `Computer error — ${latest.reason}` : "Computer error", "failed");

  // The story is the run in flight, or the one that just finished: what came
  // after the computer last settled. A step per provisioning event, the latest
  // still spinning, earlier ones checked off.
  const run = entries.slice(
    entries.slice(0, -1).findLastIndex((entry) => SETTLED.has(entry.status)) + 1
  );
  const steps: EnvLine[] = run
    .filter((entry) => entry.status === "provisioning")
    .map((entry) => ({ key: `step-${entry.id}`, label: stepLabel(entry.step), icon: "done" }));
  if (latest.status === "running") {
    const title = latest.snapshotRestored ? "Computer ready — session restored" : "Computer ready";
    return { ...line(title, "ready"), steps };
  }
  if (steps.length > 0) steps[steps.length - 1].icon = "active";
  // A wake is its title. An unknown status from a newer platform is in flight
  // by contract (the set is open), so it spins under its own humanized words.
  const title = run.some((entry) => entry.status === "resuming")
    ? "Waking computer"
    : steps.length > 0
      ? CLOUD_STARTING
      : stepLabel(latest.status);
  return { ...line(title, "running"), steps };
}

/** One environment group: a run of events at one point in the transcript. */
export function CloudEnvGroup({ entries }: { entries: CloudEnvEntry[] }) {
  const group = useMemo(() => buildGroup(entries), [entries]);
  return group && <EnvGroup {...group} />;
}
