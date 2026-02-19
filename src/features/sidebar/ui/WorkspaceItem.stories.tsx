import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Workspace, DiffStats } from "@/shared/types";
import { WorkspaceItem } from "./WorkspaceItem";

const BASE_WORKSPACE: Workspace = {
  id: "ws-1",
  repository_id: "repo-1",
  directory_name: "addis-ababa",
  display_name: "Addis Ababa",
  branch: "zvadaadam/restart-dev-server",
  parent_branch: "main",
  state: "ready",
  active_session_id: "session-1",
  session_status: "idle",
  model: "sonnet",
  latest_message_sent_at: new Date(Date.now() - 120_000).toISOString(),
  created_at: new Date().toISOString(),
  updated_at: new Date(Date.now() - 120_000).toISOString(),
  repo_name: "sample-backend",
  root_path: "/code/sample-backend",
  workspace_path: "/code/sample-backend/.hive/addis-ababa",
  setup_status: "none",
  setup_error: null,
};

function ws(overrides: Partial<Workspace>): Workspace {
  return { ...BASE_WORKSPACE, ...overrides };
}

const DIFF: DiffStats = { additions: 713, deletions: 2 };
const DIFF_BIG: DiffStats = { additions: 7277, deletions: 17 };
const DIFF_NONE: DiffStats = { additions: 0, deletions: 0 };

const noop = () => {};

const meta: Meta<typeof WorkspaceItem> = {
  title: "Sidebar/WorkspaceItem",
  component: WorkspaceItem,
  decorators: [
    (Story) => (
      <div className="bg-bg-sidebar w-[320px] rounded-lg p-1.5">
        <ul className="flex flex-col">
          <Story />
        </ul>
      </div>
    ),
  ],
  args: {
    onClick: noop,
    onArchive: noop,
  },
};
export default meta;

type Story = StoryObj<typeof WorkspaceItem>;

/** All status states side by side for quick comparison */
export const AllStates: Story = {
  render: () => (
    <div className="bg-bg-sidebar w-[320px] rounded-lg p-1.5">
      <ul className="flex flex-col">
        {/* Working — PixelGrid animation + duration */}
        <WorkspaceItem
          workspace={ws({
            id: "working",
            session_status: "working",
            branch: "zvadaadam/restart-dev-server",
            directory_name: "addis-ababa",
            latest_message_sent_at: new Date(Date.now() - 90_000).toISOString(),
          })}
          isActive={false}
          diffStats={DIFF}
          onClick={noop}
          onArchive={noop}
        />

        {/* Unread — gold dot + "Needs response" */}
        <WorkspaceItem
          workspace={ws({
            id: "unread",
            session_status: "needs_response",
            branch: "zvadaadam/fix-websocket-conn",
            directory_name: "rome-v1",
            updated_at: new Date(Date.now() - 600_000).toISOString(),
          })}
          isActive={false}
          diffStats={{ additions: 229, deletions: 12 }}
          onClick={noop}
          onArchive={noop}
        />

        {/* Error — red dot indicator */}
        <WorkspaceItem
          workspace={ws({
            id: "error",
            session_status: "error",
            branch: "zvadaadam/fix-triple-sandbox",
            directory_name: "vienna",
            updated_at: new Date(Date.now() - 3600_000).toISOString(),
          })}
          isActive={false}
          diffStats={{ additions: 1131, deletions: 297 }}
          onClick={noop}
          onArchive={noop}
        />

        {/* Idle — no icon, time ago */}
        <WorkspaceItem
          workspace={ws({
            id: "idle-recent",
            session_status: "idle",
            branch: "zvadaadam/chat-image-url-input",
            directory_name: "nairobi",
            updated_at: new Date(Date.now() - 7 * 3600_000).toISOString(),
          })}
          isActive={false}
          diffStats={DIFF_NONE}
          onClick={noop}
          onArchive={noop}
        />

        {/* Idle — no icon, days ago, with changes */}
        <WorkspaceItem
          workspace={ws({
            id: "idle-old",
            session_status: "idle",
            branch: "zvadaadam/secure-api-key-passing",
            directory_name: "istanbul-v1",
            updated_at: new Date(Date.now() - 7 * 24 * 3600_000).toISOString(),
          })}
          isActive={false}
          diffStats={{ additions: 62, deletions: 66 }}
          onClick={noop}
          onArchive={noop}
        />

        {/* Idle — months ago */}
        <WorkspaceItem
          workspace={ws({
            id: "idle-months",
            session_status: "idle",
            branch: "simplify-claude-md",
            directory_name: "muscat",
            updated_at: new Date(Date.now() - 60 * 24 * 3600_000).toISOString(),
          })}
          isActive={false}
          diffStats={{ additions: 169, deletions: 303 }}
          onClick={noop}
          onArchive={noop}
        />
      </ul>
    </div>
  ),
};

/** Working state with PixelGrid animation */
export const Working: Story = {
  args: {
    workspace: ws({
      session_status: "working",
      latest_message_sent_at: new Date(Date.now() - 90_000).toISOString(),
    }),
    isActive: false,
    diffStats: DIFF,
  },
};

/** Working + selected (active) */
export const WorkingSelected: Story = {
  args: {
    workspace: ws({
      session_status: "working",
      latest_message_sent_at: new Date(Date.now() - 90_000).toISOString(),
    }),
    isActive: true,
    diffStats: DIFF_BIG,
  },
};

/** Unread messages — gold dot indicator */
export const Unread: Story = {
  args: {
    workspace: ws({
      session_status: "needs_response",
      branch: "zvadaadam/fix-websocket-conn",
      directory_name: "rome-v1",
    }),
    isActive: false,
    diffStats: { additions: 229, deletions: 12 },
  },
};

/** Unread + selected */
export const UnreadSelected: Story = {
  args: {
    workspace: ws({
      session_status: "needs_response",
      branch: "zvadaadam/fix-websocket-conn",
      directory_name: "rome-v1",
    }),
    isActive: true,
    diffStats: { additions: 229, deletions: 12 },
  },
};

/** Error state — red dot indicator */
export const Error: Story = {
  args: {
    workspace: ws({
      session_status: "error",
      branch: "zvadaadam/fix-triple-sandbox",
      directory_name: "vienna",
    }),
    isActive: false,
    diffStats: { additions: 1131, deletions: 297 },
  },
};

/** Idle — no icon, time ago, with changes */
export const Idle: Story = {
  args: {
    workspace: ws({
      session_status: "idle",
      branch: "zvadaadam/secure-api-key-passing",
      directory_name: "istanbul-v1",
      updated_at: new Date(Date.now() - 7 * 3600_000).toISOString(),
    }),
    isActive: false,
    diffStats: { additions: 62, deletions: 66 },
  },
};

/** Idle with no diff changes */
export const IdleNoChanges: Story = {
  args: {
    workspace: ws({
      session_status: "idle",
      branch: "zvadaadam/chat-image-url-input",
      directory_name: "nairobi",
      updated_at: new Date(Date.now() - 7 * 3600_000).toISOString(),
    }),
    isActive: false,
    diffStats: DIFF_NONE,
  },
};

/** Idle + selected */
export const IdleSelected: Story = {
  args: {
    workspace: ws({
      session_status: "idle",
      branch: "zvadaadam/secure-api-key-passing",
      directory_name: "istanbul-v1",
      updated_at: new Date(Date.now() - 7 * 3600_000).toISOString(),
    }),
    isActive: true,
    diffStats: { additions: 62, deletions: 66 },
  },
};

/** Archived workspace */
export const Archived: Story = {
  args: {
    workspace: ws({
      state: "archived",
      session_status: null,
      branch: "zvadaadam/old-feature",
      directory_name: "lima",
    }),
    isActive: false,
  },
};

/** Long branch name — tests truncation */
export const LongBranchName: Story = {
  args: {
    workspace: ws({
      session_status: "working",
      branch: "zvadaadam/very-long-branch-name-that-should-be-truncated-properly",
      directory_name: "belo-horizonte",
      latest_message_sent_at: new Date(Date.now() - 30_000).toISOString(),
    }),
    isActive: false,
    diffStats: { additions: 95, deletions: 6 },
  },
};

/** Large diff numbers */
export const LargeDiff: Story = {
  args: {
    workspace: ws({
      session_status: "idle",
      branch: "zvadaadam/brasilia",
      directory_name: "brasilia",
      updated_at: new Date(Date.now() - 24 * 3600_000).toISOString(),
    }),
    isActive: false,
    diffStats: { additions: 77780, deletions: 0 },
  },
};
