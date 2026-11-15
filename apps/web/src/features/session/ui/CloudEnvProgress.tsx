/**
 * Cloud environment progress — the Cursor-style setup story in the chat.
 *
 * Renders the ephemeral `cloudEnvironment` stream (agnt workspace.state
 * passthrough) as an environment line in the transcript (EnvGroup, the line a
 * local workspace's start uses too): the summary is the live truth (active
 * step spinning while in flight, "Computer ready" when done, "Sandbox paused"
 * when asleep), and the chevron expands the full step list. Groups are
 * spliced into the timeline chronologically (chatTimeline.insertCloudEnv),
 * so a wake reads: your message → setup lines → the reply. Nothing is
 * persisted — a refresh clears the story.
 */

import { useEffect, useMemo } from "react";
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

function buildLines(entries: CloudEnvEntry[]): EnvLine[] {
  const latest = entries[entries.length - 1];
  if (!latest) return [];

  // Settled-bad states replace the stack — old provisioning steps are stale
  // noise next to "the sandbox is paused".
  if (latest.status === "paused") {
    return [
      {
        key: `paused-${latest.id}`,
        label: "Computer paused — it wakes on your next message",
        icon: "asleep",
        tone: "muted",
      },
    ];
  }
  if (latest.status === "stopped") {
    return [
      {
        key: `stopped-${latest.id}`,
        label: latest.reason ? `Computer stopped — ${latest.reason}` : "Computer stopped",
        icon: "asleep",
        tone: "muted",
      },
    ];
  }
  if (latest.status === "error") {
    return [
      {
        key: `error-${latest.id}`,
        label: latest.reason ? `Computer error — ${latest.reason}` : "Computer error",
        icon: "error",
        tone: "error",
      },
    ];
  }

  // In-flight (or finished) provisioning: one line per step, the latest
  // still spinning, earlier ones checked off.
  const lines: EnvLine[] = [];
  for (const entry of entries) {
    if (entry.status === "provisioning") {
      lines.push({ key: `step-${entry.id}`, label: stepLabel(entry.step), icon: "done" });
    } else if (entry.status === "resuming") {
      lines.push({ key: `resume-${entry.id}`, label: "Waking computer", icon: "done" });
    }
  }
  if (latest.status === "running") {
    lines.push({
      key: `ready-${latest.id}`,
      label: latest.snapshotRestored ? "Computer ready — session restored" : "Computer ready",
      icon: "done",
      tone: "ready",
    });
  } else if (lines.length > 0) {
    lines[lines.length - 1].icon = "active";
  } else {
    // Unknown status from a newer platform — the schema is an open set by
    // contract ("treat unknown statuses as in-flight"), so show it spinning
    // with a humanized label rather than vanishing the marker.
    lines.push({ key: `status-${latest.id}`, label: stepLabel(latest.status), icon: "active" });
  }
  return lines;
}

/** One environment group — a run of events at one point in the transcript.
 *  Collapsed by default to its latest/live line. */
export function CloudEnvGroup({ entries }: { entries: CloudEnvEntry[] }) {
  const lines = useMemo(() => buildLines(entries), [entries]);
  if (lines.length === 0) return null;
  return <EnvGroup summary={lines[lines.length - 1]} detail={lines.slice(0, -1)} />;
}
