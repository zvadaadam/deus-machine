/**
 * Cloud environment progress — the Cursor-style setup story in the chat.
 *
 * Renders the ephemeral q:event "cloud:env" stream (agnt workspace.state
 * passthrough) as a COLLAPSED one-liner in the transcript, matching the
 * tool-call group pattern: the summary line is the live truth (active step
 * spinning while in flight, "Environment ready" when done, "Sandbox paused"
 * when asleep), and the chevron expands the full step list. Groups are
 * spliced into the timeline chronologically (chatTimeline.insertCloudEnv),
 * so a wake reads: your message → setup lines → the reply. Nothing is
 * persisted — a refresh clears the story.
 */

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, m } from "framer-motion";
import { Check, ChevronRight, CloudOff, Loader2, TriangleAlert } from "lucide-react";
import { cn } from "@/shared/lib/utils";
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

interface Line {
  key: string;
  label: string;
  icon: "done" | "active" | "asleep" | "error";
  tone?: "ready" | "muted" | "error";
}

function buildLines(entries: CloudEnvEntry[]): Line[] {
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
        label: latest.reason ? `Environment error — ${latest.reason}` : "Environment error",
        icon: "error",
        tone: "error",
      },
    ];
  }

  // In-flight (or finished) provisioning: one line per step, the latest
  // still spinning, earlier ones checked off.
  const lines: Line[] = [];
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
      label: latest.snapshotRestored ? "Environment ready — session restored" : "Environment ready",
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

function LineIcon({ icon }: { icon: Line["icon"] }) {
  switch (icon) {
    case "active":
      return <Loader2 className="text-text-muted h-3 w-3 flex-shrink-0 animate-spin" />;
    case "done":
      return <Check className="text-accent-green h-3 w-3 flex-shrink-0" />;
    case "asleep":
      return <CloudOff className="text-text-disabled h-3 w-3 flex-shrink-0" />;
    case "error":
      return <TriangleAlert className="text-destructive/80 h-3 w-3 flex-shrink-0" />;
  }
}

function lineTextClass(tone: Line["tone"]): string {
  return cn(
    "font-mono text-xs tracking-tight",
    tone === "error"
      ? "text-destructive/80"
      : tone === "ready"
        ? "text-text-secondary"
        : "text-text-muted"
  );
}

/** One collapsible environment group — a run of events at one point in the
 *  transcript. Collapsed by default to its latest/live line. */
export function CloudEnvGroup({ entries }: { entries: CloudEnvEntry[] }) {
  const [expanded, setExpanded] = useState(false);
  const lines = useMemo(() => buildLines(entries), [entries]);
  if (lines.length === 0) return null;

  const summary = lines[lines.length - 1];
  const detail = lines.slice(0, -1);
  const hasDetail = detail.length > 0;

  return (
    <div className="flex w-full min-w-0 flex-col" role="status" aria-live="polite">
      <button
        type="button"
        onClick={() => hasDetail && setExpanded(!expanded)}
        disabled={!hasDetail}
        aria-expanded={hasDetail ? expanded : undefined}
        className={cn(
          "group flex w-full items-center gap-2 px-2 py-1 text-left",
          hasDetail && "cursor-pointer",
          "transition-opacity duration-150 ease-out",
          hasDetail && "opacity-90 hover:opacity-100",
          "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none"
        )}
      >
        <div className="relative h-3 w-3 flex-shrink-0">
          <div
            className={cn(
              "absolute top-0 left-0 transition-opacity duration-150 ease-out",
              hasDetail && (expanded ? "opacity-0" : "opacity-100 group-hover:opacity-0")
            )}
          >
            <LineIcon icon={summary.icon} />
          </div>
          {hasDetail && (
            <ChevronRight
              className={cn(
                "text-muted-foreground/50 absolute top-0 left-0 h-3 w-3 transition-[transform,opacity] duration-150 ease-out",
                expanded && "rotate-90",
                expanded ? "opacity-100" : "opacity-0 group-hover:opacity-100"
              )}
              aria-hidden="true"
            />
          )}
        </div>
        <span className={lineTextClass(summary.tone)}>{summary.label}</span>
        {hasDetail && (
          <span className="text-muted-foreground/40 font-mono text-xs" aria-hidden="true">
            · {detail.length + 1} steps
          </span>
        )}
      </button>

      <AnimatePresence>
        {expanded && hasDetail && (
          <m.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18, ease: [0.215, 0.61, 0.355, 1] }}
            className="flex flex-col overflow-hidden"
          >
            {detail.map((line) => (
              <div key={line.key} className="flex items-center gap-2 px-2 py-0.5 pl-7">
                <LineIcon icon={line.icon} />
                <span className={lineTextClass(line.tone)}>{line.label}</span>
              </div>
            ))}
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}
