/**
 * Status chip for one AAP app card. Pure presentational — renders a colored
 * dot + label derived from the chip status.
 *
 * Status mapping:
 *   idle     — no running entry in the workspace (gray)
 *   starting — spawn happened, probe still running (amber)
 *   ready    — probe succeeded, app URL is live (green)
 *   stopping — SIGTERM sent, waiting for child exit (amber)
 *
 * "crashed" is intentionally omitted: terminal entries are deleted from
 * apps.service runningApps Map, so RunningStatus never reaches this chip
 * in that state. If a crash happens mid-view the card's hook just flips
 * back to idle (absence of entry).
 */

import { match } from "ts-pattern";
import { cn } from "@/shared/lib/utils";
import type { RunningStatus } from "@shared/aap/types";

export type AppChipStatus = RunningStatus | "idle";

interface AppStatusChipProps {
  status: AppChipStatus;
  className?: string;
}

export function AppStatusChip({ status, className }: AppStatusChipProps) {
  const { dotClass, label } = match(status)
    .with("idle", () => ({ dotClass: "bg-text-muted", label: "idle" }))
    .with("starting", () => ({ dotClass: "bg-accent-gold", label: "starting" }))
    .with("ready", () => ({ dotClass: "bg-success", label: "running" }))
    .with("stopping", () => ({ dotClass: "bg-accent-gold", label: "stopping" }))
    .exhaustive();

  return (
    <span
      data-slot="app-status-chip"
      data-status={status}
      className={cn("text-text-muted inline-flex items-center gap-1.5 text-xs", className)}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", dotClass)} />
      <span>{label}</span>
    </span>
  );
}
