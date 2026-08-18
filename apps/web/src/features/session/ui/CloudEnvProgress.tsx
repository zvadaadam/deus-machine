/**
 * Live cloud environment progress inside the chat — the Cursor-style
 * "Provisioning… / Cloning repository… / Restoring session state…" stack.
 *
 * Renders the ephemeral q:event "cloud:env" stream (agnt workspace.state
 * passthrough) for this chat's workspace. Nothing is persisted: a refresh
 * clears it, and a completed provisioning fades out after a beat. Local
 * workspaces never receive these events, so this renders nothing for them.
 */

import { useEffect, useMemo } from "react";
import { AnimatePresence, m } from "framer-motion";
import { Check, Cloud, CloudOff, Loader2, TriangleAlert } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import {
  useCloudEnvStore,
  ensureCloudEnvSubscription,
  type CloudEnvEntry,
} from "../store/cloudEnvStore";

/** How long the all-green "Environment ready" stack lingers before fading. */
const READY_LINGER_MS = 3500;

const STEP_LABELS: Record<string, string> = {
  initializing: "Initializing sandbox",
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
  if (!step) return "Provisioning sandbox";
  const known = STEP_LABELS[step];
  if (known) return known;
  const words = step.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

interface Line {
  key: string;
  label: string;
  icon: "done" | "active" | "cloud" | "asleep" | "error";
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
        label: "Sandbox paused — it wakes on your next message",
        icon: "asleep",
        tone: "muted",
      },
    ];
  }
  if (latest.status === "stopped") {
    return [
      {
        key: `stopped-${latest.id}`,
        label: latest.reason ? `Sandbox stopped — ${latest.reason}` : "Sandbox stopped",
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

  // In-flight (or just-finished) provisioning: one line per step, the latest
  // still spinning, earlier ones checked off.
  const lines: Line[] = [];
  for (const entry of entries) {
    if (entry.status === "provisioning") {
      lines.push({ key: `step-${entry.id}`, label: stepLabel(entry.step), icon: "done" });
    } else if (entry.status === "resuming") {
      lines.push({ key: `resume-${entry.id}`, label: "Waking sandbox", icon: "done" });
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
    case "cloud":
      return <Cloud className="text-text-muted h-3 w-3 flex-shrink-0" />;
  }
}

export function CloudEnvProgress({ workspaceId }: { workspaceId?: string | null }) {
  const entries = useCloudEnvStore((s) => (workspaceId ? s.byWorkspace[workspaceId] : undefined));
  const clearWorkspace = useCloudEnvStore((s) => s.clearWorkspace);

  useEffect(() => {
    ensureCloudEnvSubscription();
  }, []);

  const latest = entries?.[entries.length - 1];

  // A finished provisioning lingers briefly, then the whole stack fades.
  useEffect(() => {
    if (!workspaceId || latest?.status !== "running") return;
    const elapsed = Date.now() - latest.at;
    const t = setTimeout(() => clearWorkspace(workspaceId), Math.max(READY_LINGER_MS - elapsed, 0));
    return () => clearTimeout(t);
  }, [workspaceId, latest, clearWorkspace]);

  const lines = useMemo(() => buildLines(entries ?? []), [entries]);

  return (
    <AnimatePresence>
      {lines.length > 0 && (
        <m.div
          key="cloud-env-progress"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25, ease: [0.215, 0.61, 0.355, 1] }}
          role="status"
          aria-live="polite"
          className="mr-auto flex flex-col gap-1 px-2 py-1.5"
        >
          {lines.map((line) => (
            <m.div
              key={line.key}
              initial={{ opacity: 0, y: 2 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, ease: [0.215, 0.61, 0.355, 1] }}
              className="flex items-center gap-2"
            >
              <LineIcon icon={line.icon} />
              <span
                className={cn(
                  "font-mono text-xs tracking-tight",
                  line.tone === "error"
                    ? "text-destructive/80"
                    : line.tone === "ready"
                      ? "text-text-secondary"
                      : "text-text-muted"
                )}
              >
                {line.label}
              </span>
            </m.div>
          ))}
        </m.div>
      )}
    </AnimatePresence>
  );
}
