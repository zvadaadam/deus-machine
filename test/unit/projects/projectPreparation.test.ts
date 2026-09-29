import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ProjectPreparation, preparationSteps } from "@/features/projects/ui/ProjectPreparation";

const label = (steps: ReturnType<typeof preparationSteps>) =>
  steps.map((step) => `${step.key}:${step.state}`);

it("projects the initializer stage into a checklist", () => {
  expect(label(preparationSteps(undefined, false))).toEqual([
    "reserved:active",
    "worktree:pending",
    "hooks:pending",
    "setup:pending",
    "session:pending",
  ]);
  expect(
    label(
      preparationSteps(
        { state: "initializing", init_stage: "pending", setup_status: "none" },
        false
      )
    )
  ).toEqual([
    "reserved:done",
    "worktree:pending",
    "hooks:pending",
    "setup:pending",
    "session:pending",
  ]);
  expect(
    label(
      preparationSteps(
        { state: "initializing", init_stage: "setup", setup_status: "running" },
        false
      )
    )
  ).toEqual(["reserved:done", "worktree:done", "hooks:done", "setup:active", "session:pending"]);
  expect(
    label(preparationSteps({ state: "ready", init_stage: "done", setup_status: "completed" }, true))
  ).toEqual(["reserved:done", "worktree:done", "hooks:done", "setup:done", "session:done"]);
});

it("keeps a failed worktree and a repairable setup visible", () => {
  const failed = preparationSteps(
    { state: "error", init_stage: "worktree", setup_status: "none" },
    false
  );
  expect(failed[1]).toEqual({
    key: "worktree",
    label: "Creating an isolated worktree failed",
    state: "failed",
  });
  expect(label(failed).slice(2)).toEqual(["hooks:pending", "setup:pending", "session:pending"]);
  const repaired = preparationSteps(
    { state: "ready", init_stage: "done", setup_status: "failed" },
    true
  );
  expect(repaired[3]).toEqual({
    key: "setup",
    label: "Setup failed; the coordinator can repair it",
    state: "warning",
  });
  expect(label(repaired)).toEqual([
    "reserved:done",
    "worktree:done",
    "hooks:done",
    "setup:warning",
    "session:done",
  ]);
});

it("renders the current step, the error and a retry affordance", () => {
  const html = renderToStaticMarkup(
    createElement(
      ProjectPreparation,
      {
        workspace: { state: "initializing", init_stage: "hooks", setup_status: "none" },
        ready: false,
        title: "Preparing your coordinator",
        error: null,
      },
      null
    )
  );
  expect(html).toContain("Preparing your coordinator");
  expect(html).toContain("Created an isolated worktree");
  expect(html).toContain("Setting up the environment");
  expect(html).toContain("You can leave this page");
  const failed = renderToStaticMarkup(
    createElement(
      ProjectPreparation,
      {
        workspace: { state: "error", init_stage: "worktree", setup_status: "none" },
        ready: false,
        title: "Coordinator needs attention",
        error: "git worktree add failed",
      },
      createElement("button", null, "Retry preparation")
    )
  );
  expect(failed).toContain("git worktree add failed");
  expect(failed).toContain("Retry preparation");
  expect(failed).not.toContain("You can leave this page");
});

it("words the checklist for a contributor agent", () => {
  const steps = preparationSteps(
    { state: "initializing", init_stage: "session", setup_status: "completed" },
    false,
    "agent"
  );
  expect(steps[0].label).toBe("Reserved the agent workspace");
  expect(steps[4]).toEqual({ key: "session", label: "Starting the agent", state: "active" });
  const html = renderToStaticMarkup(
    createElement(ProjectPreparation, {
      workspace: { state: "initializing", init_stage: "session", setup_status: "completed" },
      ready: false,
      title: "Preparing CSV import",
      subject: "agent",
    })
  );
  expect(html).toContain("This agent starts as soon as its");
});
