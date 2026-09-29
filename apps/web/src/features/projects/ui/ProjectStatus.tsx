import {
  Circle,
  CircleCheck,
  CirclePause,
  LoaderCircle,
  Square,
  TriangleAlert,
} from "lucide-react";
import { match } from "ts-pattern";
import type { ProjectStatus as Status } from "@shared/projects";
import { cn } from "@/shared/lib/utils";

export function getProjectStatusPresentation(status: Status) {
  return match(status)
    .with("preparing", () => ({
      label: "Preparing",
      compactLabel: "Preparing",
      Icon: LoaderCircle,
      className: "text-text-secondary",
    }))
    .with("working", () => ({
      label: "Working",
      compactLabel: "Running",
      Icon: LoaderCircle,
      className: "text-info",
    }))
    .with("queued", () => ({
      label: "Work queued",
      compactLabel: "Queued",
      Icon: Circle,
      className: "text-text-secondary",
    }))
    .with("idle", () => ({
      label: "Waiting for direction",
      compactLabel: "Idle",
      Icon: Circle,
      className: "text-text-secondary",
    }))
    .with("ready", () => ({
      label: "Ready for review",
      compactLabel: "Ready",
      Icon: CircleCheck,
      className: "text-success",
    }))
    .with("done", () => ({
      label: "Done",
      compactLabel: "Done",
      Icon: CircleCheck,
      className: "text-success",
    }))
    .with("paused", () => ({
      label: "Stopped",
      compactLabel: "Stopped",
      Icon: Square,
      className: "text-text-tertiary",
    }))
    .with("needs-attention", () => ({
      label: "Needs attention",
      compactLabel: "Attention",
      Icon: TriangleAlert,
      className: "text-warning",
    }))
    .with("limit-reached", () => ({
      label: "Turn limit reached",
      compactLabel: "Turn limit",
      Icon: CirclePause,
      className: "text-warning",
    }))
    .with("archived", () => ({
      label: "Archived",
      compactLabel: "Archived",
      Icon: Circle,
      className: "text-text-tertiary",
    }))
    .exhaustive();
}

export function ProjectStatus({ status }: { status: Status }) {
  const { label, Icon, className } = getProjectStatusPresentation(status);
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 text-xs", className)}>
      <Icon
        aria-hidden
        className={cn(
          "size-3.5",
          (status === "working" || status === "preparing") && "motion-safe:animate-spin"
        )}
      />
      {label}
    </span>
  );
}
