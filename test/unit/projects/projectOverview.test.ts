import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { ProjectAgent, ProjectDetail } from "@shared/projects";
import { ProjectOverview } from "@/features/projects/ui/ProjectOverview";

const state = vi.hoisted(() => ({ mutate: vi.fn(), openExternal: vi.fn(), error: vi.fn() }));
vi.mock("@/features/projects/api/projects.queries", () => ({
  useProjectAction: () => ({ mutate: state.mutate, isPending: false }),
}));
vi.mock("sonner", () => ({ toast: { error: state.error } }));
vi.mock("@/platform", () => ({ native: { window: { openExternal: state.openExternal } } }));
vi.mock("@/features/projects/ui/ProjectMarkdown", () => ({
  ProjectMarkdown: ({ children }: { children: string }) => createElement("div", null, children),
}));

const coordinator: ProjectAgent = {
  id: "coordinator",
  workspaceId: "coordinator",
  sessionId: "session",
  title: "Coordinator",
  role: "coordinator",
  status: "idle",
  assignmentId: "assignment",
  task: "",
  error: null,
  paused: false,
};
const project = {
  id: "project",
  title: "Ledger",
  status: "idle",
  paused: false,
  brief: "",
  activeAgentCount: 0,
  agents: [coordinator],
  reports: [],
  pullRequests: [],
  pendingInputCount: 0,
  pendingMessageCount: 0,
  pendingMessages: [],
} as unknown as ProjectDetail;
const render = (
  detail: ProjectDetail,
  extra: Partial<Parameters<typeof ProjectOverview>[0]> = {}
) =>
  renderToStaticMarkup(
    createElement(ProjectOverview, {
      project: detail,
      onOpenAgent: vi.fn(),
      onOpenFile: vi.fn(),
      ...extra,
    })
  );

beforeEach(() => vi.clearAllMocks());

it("says there is nothing to track until the coordinator has a brief", () => {
  const html = render(project);
  expect(html).toContain("Nothing to track yet");
  expect(html).toContain("Waiting for your first instruction");
  expect(html).toContain('aria-label="Open Coordinator"');
  expect(html).not.toContain("Pull requests");
  expect(html).not.toContain("project-results-heading");
});

it("tracks agents, results and pull requests once a brief exists", () => {
  const html = render({
    ...project,
    brief: "Build a pocket ledger",
    agents: [{ ...coordinator, task: "Build a pocket ledger" }],
  });
  expect(html).not.toContain("Nothing to track yet");
  expect(html).toContain("Build a pocket ledger");
  expect(html).toContain("Pull requests");
  expect(html).toContain("project-results-heading");
});

it("keeps tracking a brief-less project once it has evidence", () => {
  const html = render({
    ...project,
    reports: [
      {
        id: "report",
        agentId: "coordinator",
        agentTitle: "Coordinator",
        assignmentId: "assignment",
        sessionId: "session",
        turnId: "turn",
        summary: "Published the plan",
        files: [],
        pullRequests: [],
        revision: 1,
        createdAt: 1,
        accepted: false,
        ready: true,
      },
    ],
  });
  expect(html).not.toContain("Nothing to track yet");
  expect(html).toContain("Published the plan");
});

it("marks the open agent and shows each agent's uncommitted changes", () => {
  const contributor: ProjectAgent = {
    ...coordinator,
    id: "child",
    workspaceId: "child-workspace",
    sessionId: null,
    title: "CSV import",
    role: "contributor",
    status: "preparing",
    task: "Import CSV files",
  };
  const html = render(
    { ...project, brief: "Ledger", agents: [coordinator, contributor] },
    {
      activeAgentId: "child",
      diffStats: { "child-workspace": { additions: 12, deletions: 3 } },
      onOpenChanges: vi.fn(),
    }
  );
  const rows = html.split('data-slot="project-agent-row"');
  expect(rows[1]).not.toContain("data-selected");
  expect(rows[2]).toContain('data-selected="true"');
  expect(rows[2]).toContain('aria-current="true"');
  // A preparing agent can still be opened: its tab shows the preparation steps.
  expect(rows[2]).not.toMatch(/aria-label="Open CSV import"[^>]*disabled/);
  expect(rows[2]).toContain('aria-label="CSV import changes: 12 added, 3 removed"');
  expect(rows[2]).toContain("+12");
  expect(rows[2]).toContain("-3");
  expect(rows[1]).not.toContain("added,");
});
