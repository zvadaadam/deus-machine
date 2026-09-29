import type { ReactNode } from "react";
import { Check, Circle, LoaderCircle, TriangleAlert } from "lucide-react";
import type { Workspace } from "@/shared/types";
import { cn } from "@/shared/lib/utils";

export type PreparationStepState = "done" | "active" | "pending" | "failed" | "warning";
export interface PreparationStep {
  key: string;
  label: string;
  state: PreparationStepState;
}

/** Who the workspace is being prepared for; only the wording differs. */
export type PreparationSubject = "coordinator" | "agent";

/** The workspace initializer's stages, in order, with the words a user reads. */
const STAGES = [
  {
    key: "worktree",
    active: () => "Creating an isolated worktree",
    done: () => "Created an isolated worktree",
  },
  { key: "hooks", active: () => "Setting up the environment", done: () => "Environment ready" },
  { key: "setup", active: () => "Running the repository setup", done: () => "Setup finished" },
  {
    key: "session",
    active: (subject: PreparationSubject) => `Starting the ${subject}`,
    done: (subject: PreparationSubject) =>
      subject === "coordinator" ? "Coordinator started" : "Agent started",
  },
] as const;

type PreparationWorkspace = Pick<Workspace, "state" | "init_stage" | "setup_status"> | undefined;

/**
 * Projects an agent workspace's `init_stage` into a checklist. `ready` is the
 * agent's conversation existing, which the last stage produces.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function preparationSteps(
  workspace: PreparationWorkspace,
  ready: boolean,
  subject: PreparationSubject = "coordinator"
): PreparationStep[] {
  const stage = workspace?.init_stage ?? "pending";
  const failed = workspace?.state === "error";
  const finished = ready || stage === "done" || workspace?.state === "ready";
  const current = STAGES.findIndex((candidate) => candidate.key === stage);
  return [
    {
      key: "reserved",
      label: workspace
        ? `Reserved the ${subject === "coordinator" ? "project" : "agent"} workspace`
        : `Reserving the ${subject === "coordinator" ? "project" : "agent"} workspace`,
      state: workspace ? "done" : "active",
    },
    ...STAGES.map((stageInfo, index): PreparationStep => {
      const { key } = stageInfo;
      const active = stageInfo.active(subject);
      const completed = finished || (current >= 0 && index < current);
      if (key === "setup" && completed && workspace?.setup_status === "failed") {
        return { key, label: `Setup failed; the ${subject} can repair it`, state: "warning" };
      }
      if (completed) return { key, label: stageInfo.done(subject), state: "done" };
      if (index === current) {
        return failed
          ? { key, label: `${active} failed`, state: "failed" }
          : { key, label: active, state: "active" };
      }
      return { key, label: active, state: "pending" };
    }),
  ];
}

function StepIcon({ state }: { state: PreparationStepState }) {
  if (state === "done") return <Check aria-hidden className="text-success size-3.5" />;
  if (state === "active")
    return (
      <LoaderCircle aria-hidden className="text-text-secondary size-3.5 motion-safe:animate-spin" />
    );
  if (state === "failed")
    return <TriangleAlert aria-hidden className="text-destructive size-3.5" />;
  if (state === "warning") return <TriangleAlert aria-hidden className="text-warning size-3.5" />;
  return <Circle aria-hidden className="text-text-muted size-2" />;
}

/**
 * What an agent's pane shows before its conversation exists: the same
 * preparation the sidebar summarizes, as steps, so a slow setup script or a
 * failed worktree is visible where the user is looking.
 */
export function ProjectPreparation({
  workspace,
  ready,
  title,
  subject = "coordinator",
  error,
  children,
  className,
}: {
  workspace: PreparationWorkspace;
  ready: boolean;
  title: string;
  subject?: PreparationSubject;
  error?: string | null;
  children?: ReactNode;
  className?: string;
}) {
  const steps = preparationSteps(workspace, ready, subject);
  const failed = steps.some((step) => step.state === "failed");
  return (
    <div className={cn("flex flex-1 flex-col items-center justify-center p-8", className)}>
      <div className="w-full max-w-sm" data-slot="project-preparation">
        <p className="text-text-primary mb-3 text-sm font-medium">{title}</p>
        <ol aria-label="Preparation steps" className="flex flex-col gap-2">
          {steps.map((step) => (
            <li key={step.key} data-state={step.state} className="flex items-center gap-2 text-sm">
              <span className="flex size-4 shrink-0 items-center justify-center">
                <StepIcon state={step.state} />
              </span>
              <span
                className={cn(
                  step.state === "pending" ? "text-text-tertiary" : "text-text-secondary",
                  step.state === "active" && "text-text-primary"
                )}
              >
                {step.label}
              </span>
            </li>
          ))}
        </ol>
        {error && (
          <p role="status" className="text-text-secondary mt-3 text-xs leading-relaxed">
            {error}
          </p>
        )}
        {children && <div className="mt-3">{children}</div>}
        {!failed && !error && (
          <p className="text-text-tertiary mt-3 text-xs leading-relaxed">
            {subject === "coordinator" ? "The coordinator" : "This agent"} starts as soon as its
            workspace is ready. You can leave this page while it prepares.
          </p>
        )}
      </div>
    </div>
  );
}
