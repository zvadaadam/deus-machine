import { Children, createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { AppSidebar } from "@/features/sidebar/ui/AppSidebar";
import { ProjectsSidebar } from "@/features/sidebar/ui/ProjectsSidebar";
import type { ProjectSummary } from "@shared/projects";
import type { RepoGroup } from "@shared/types/workspace";

const state = vi.hoisted(() => ({
  projects: [] as ProjectSummary[],
  selected: null as string | null,
  collapsed: false,
  mobile: false,
  webDirect: false,
  onOpen: vi.fn(),
  onCreate: vi.fn(),
  closeMobile: vi.fn(),
  buttons: new Map<string, { onClick: () => void }>(),
  repositories: [] as RepoGroup[],
}));

vi.mock("@/features/projects/api/projects.queries", () => ({
  useProjects: () => ({ data: state.projects, isPending: false, isError: false }),
}));
vi.mock("@/shared/stores/uiStore", () => ({
  useUIStore: (selector: (value: unknown) => unknown) =>
    selector({
      selectedProjectId: state.selected,
      openSettings: vi.fn(),
      openNewWorkspaceModal: state.onCreate,
    }),
}));
vi.mock("@/features/sidebar/store/sidebarStore", () => ({
  useSidebarStore: (selector: (value: unknown) => unknown) =>
    selector({
      projectsCollapsed: state.collapsed,
      toggleProjectsCollapse: () => {
        state.collapsed = !state.collapsed;
      },
      collapsedRepos: new Set(),
      toggleRepoCollapse: vi.fn(),
      repositoryOrder: [],
      setRepositoryOrder: vi.fn(),
      reorderRepositories: (repositories: RepoGroup[]) => repositories,
    }),
}));
vi.mock("@/shared/config/webDirectMode", () => ({
  isCloudDirectWebMode: () => state.webDirect,
}));
vi.mock("@/features/session/ui/CircularPixelGrid", () => ({
  CircularPixelGrid: () => createElement("span", { "data-live-indicator": true }),
}));
vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
  useReducedMotion: () => true,
  m: {
    ul: ({ children, id, className }: { children: ReactNode; id: string; className: string }) =>
      createElement("ul", { id, className }, children),
  },
}));
vi.mock("@/features/sidebar/ui/SidebarRow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/sidebar/ui/SidebarRow")>();
  return {
    ...actual,
    SidebarRow: (props: Parameters<typeof actual.SidebarRow>[0]) => {
      const capture = (children: ReactNode) =>
        Children.forEach(children, (child) => {
          if (!isValidElement<Record<string, unknown>>(child)) return;
          if (child.type === "button") {
            state.buttons.set(
              String(child.props["aria-label"]),
              child.props as { onClick: () => void }
            );
          }
          capture(child.props.children as ReactNode);
        });
      capture(props.children);
      return createElement(actual.SidebarRow, props);
    },
  };
});
vi.mock("@/components/ui/sidebar", () => {
  const container = ({ children }: { children: ReactNode }) => createElement("div", null, children);
  return {
    Sidebar: container,
    SidebarContent: container,
    SidebarMenu: container,
    useSidebar: () => ({
      state: "expanded",
      hoverOpen: false,
      isMobile: state.mobile,
      toggleSidebar: vi.fn(),
      setOpenMobile: state.closeMobile,
    }),
  };
});
vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: ReactNode }) => children,
  closestCenter: vi.fn(),
  KeyboardSensor: vi.fn(),
  MouseSensor: vi.fn(),
  TouchSensor: vi.fn(),
  useSensor: vi.fn(),
  useSensors: () => [],
}));
vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: ReactNode }) => children,
  arrayMove: vi.fn(),
  sortableKeyboardCoordinates: vi.fn(),
  verticalListSortingStrategy: vi.fn(),
}));
vi.mock("@/features/sidebar/ui/SidebarHeader", () => ({ SidebarHeader: () => null }));
vi.mock("@/features/sidebar/ui/SidebarFooter", () => ({ SidebarFooter: () => null }));
vi.mock("@/features/sidebar/ui/DraggableRepository", () => ({
  DraggableRepository: ({ repository }: { repository: RepoGroup }) => {
    state.repositories.push(repository);
    return createElement(
      "div",
      null,
      repository.workspaces.map((workspace) =>
        createElement("span", { key: workspace.id }, workspace.title)
      )
    );
  },
}));

const project = (id: string, status: ProjectSummary["status"], createdAt = 1): ProjectSummary => ({
  id,
  title: id,
  status,
  createdAt,
  updatedAt: createdAt,
  repositoryId: "repo",
  repositoryName: "Repository",
  coordinatorAgentId: `${id}-coordinator`,
  coordinatorSessionId: `${id}-session`,
  model: "claude",
  paused: false,
  agentCount: 2,
  activeAgentCount: status === "working" ? 1 : 0,
  reportCount: 0,
  dispatchCount: 1,
  dispatchLimit: 40,
  concurrencyLimit: 2,
  revision: 1,
  error: null,
});

beforeEach(() => {
  state.projects = [project("Pocket Ledger", "working")];
  state.selected = "Pocket Ledger";
  state.collapsed = false;
  state.mobile = false;
  state.webDirect = false;
  state.buttons.clear();
  state.repositories = [];
  vi.clearAllMocks();
});

function renderSection() {
  return renderToStaticMarkup(
    createElement(ProjectsSidebar, {
      isActive: true,
      sidebarExpanded: true,
      onOpen: state.onOpen,
      onCreate: state.onCreate,
    })
  );
}

function renderSidebar() {
  return renderToStaticMarkup(
    createElement(AppSidebar, {
      repositories: [
        {
          repo_id: "repo",
          repo_name: "Repository",
          sort_order: 0,
          workspaces: [
            { id: "ordinary", title: "Ordinary workspace", project_id: null },
            { id: "managed", title: "Managed agent workspace", project_id: "Pocket Ledger" },
          ],
        },
      ] as RepoGroup[],
      selectedWorkspaceId: null,
      projectsActive: true,
      onWorkspaceClick: vi.fn(),
      onNewWorkspace: vi.fn(),
      onOpenProjects: state.onOpen,
    })
  );
}

it("places Projects below Automations and keeps managed workspaces inside their Project", () => {
  const html = renderSidebar();
  expect(html.indexOf(">Automations<")).toBeLessThan(html.indexOf(">Projects<"));
  expect(html).toContain("Pocket Ledger");
  expect(html).toContain("Ordinary workspace");
  expect(html).not.toContain("Managed agent workspace");
  expect(state.repositories[0].workspaces.map((workspace) => workspace.id)).toEqual(["ordinary"]);
});

it("updates live status in place and distinguishes review-ready from accepted Done", () => {
  state.projects = [project("Older project", "working", 1), project("Newer project", "ready", 2)];
  const first = renderSection();
  expect(first.indexOf('data-project-id="Newer project"')).toBeLessThan(
    first.indexOf('data-project-id="Older project"')
  );
  expect(first).toContain(">Running<");
  expect(first).toContain(">Ready<");
  expect(first).toContain("data-live-indicator");

  state.projects = [
    { ...state.projects[0], status: "done", updatedAt: 100 },
    { ...state.projects[1], status: "needs-attention" },
  ];
  const next = renderSection();
  expect(next.indexOf('data-project-id="Newer project"')).toBeLessThan(
    next.indexOf('data-project-id="Older project"')
  );
  expect(next).toContain(">Done<");
  expect(next).toContain(">Attention<");
  expect(next).not.toContain("data-live-indicator");
});

it("opens a Project or its creation modal and closes the mobile sheet", () => {
  state.mobile = true;
  const html = renderSidebar();
  expect(html).toContain('aria-current="page"');
  state.buttons.get("Project Pocket Ledger, Working")!.onClick();
  expect(state.onOpen).toHaveBeenLastCalledWith("Pocket Ledger");
  expect(state.closeMobile).toHaveBeenLastCalledWith(false);
  expect(html).not.toContain("All Projects");
  state.buttons.get("New project")!.onClick();
  expect(state.onCreate).toHaveBeenLastCalledWith("project");
  expect(state.closeMobile).toHaveBeenLastCalledWith(false);
});

it("uses the Projects header only as disclosure and excludes archived Projects", () => {
  state.projects.push(project("Archived project", "archived"));
  expect(renderSection()).not.toContain("Archived project");
  state.buttons.get("Collapse Projects")!.onClick();
  const collapsed = renderSection();
  expect(collapsed).toContain('aria-expanded="false"');
  expect(collapsed).not.toContain("data-project-id");
  expect(state.onOpen).not.toHaveBeenCalled();
  state.buttons.get("Expand Projects")!.onClick();
  expect(renderSection()).toContain('data-project-id="Pocket Ledger"');
});
