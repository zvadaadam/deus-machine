import type { Meta, StoryObj } from "@storybook/react-vite";
import { SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WorkspaceHeader } from "./WorkspaceHeader";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

const meta: Meta<typeof WorkspaceHeader> = {
  title: "Workspace/WorkspaceHeader",
  component: WorkspaceHeader,
  decorators: [
    (Story) => (
      <QueryClientProvider client={queryClient}>
        <SidebarProvider>
          <TooltipProvider>
            <div className="bg-bg-surface w-full rounded-xl">
              <Story />
            </div>
          </TooltipProvider>
        </SidebarProvider>
      </QueryClientProvider>
    ),
  ],
  argTypes: {
    title: { control: "text" },
    repositoryName: { control: "text" },
    branch: { control: "text" },
    targetBranch: { control: "text" },
  },
};
export default meta;

type Story = StoryObj<typeof WorkspaceHeader>;

/** No PR — shows Create PR split button + Review */
export const NoPR: Story = {
  args: {
    repositoryName: "sample-backend",
    branch: "zvadaadam/fix-api-keys",
    workspacePath: "/tmp/workspace",
    onCreatePR: () => console.log("Create PR"),
    onReviewPR: () => console.log("Review PR"),
    targetBranch: "longer name for target",
  },
};

/** Title with repo/branch + Create PR + Review */
export const WithTitle: Story = {
  args: {
    title: "Restart Dev Server",
    repositoryName: "sample-backend",
    branch: "restart-dev-server",
    workspacePath: "/tmp/workspace",
    onCreatePR: () => console.log("Create PR"),
    onReviewPR: () => console.log("Review PR"),
    targetBranch: "main",
  },
};

/** PR ready to merge — Review + Merge split button */
export const PRReady: Story = {
  args: {
    repositoryName: "sample-backend",
    branch: "zvadaadam/fix-api-keys",
    workspacePath: "/tmp/workspace",
    prStatus: {
      has_pr: true,
      pr_number: 84,
      pr_title: "fix: secure API key handling",
      pr_url: "https://github.com/org/repo/pull/84",
      merge_status: "ready",
    },
    onReviewPR: () => console.log("Review PR"),
    onSendAgentMessage: (text: string) => console.log("Agent message:", text),
    targetBranch: "main",
  },
};

/** PR merged — shows Review + Archive button */
export const PRMerged: Story = {
  args: {
    repositoryName: "sample-backend",
    branch: "zvadaadam/fix-api-keys",
    workspacePath: "/tmp/workspace",
    prStatus: {
      has_pr: true,
      pr_number: 84,
      pr_title: "fix: secure API key handling",
      pr_url: "https://github.com/org/repo/pull/84",
      merge_status: "merged",
    },
    onReviewPR: () => console.log("Review PR"),
    onArchive: () => console.log("Archive workspace"),
    targetBranch: "main",
  },
};

/** PR blocked — merge left button disabled */
export const PRBlocked: Story = {
  args: {
    repositoryName: "sample-backend",
    branch: "zvadaadam/fix-api-keys",
    workspacePath: "/tmp/workspace",
    prStatus: {
      has_pr: true,
      pr_number: 84,
      pr_title: "fix: secure API key handling",
      pr_url: "https://github.com/org/repo/pull/84",
      merge_status: "blocked",
    },
    onReviewPR: () => console.log("Review PR"),
    onSendAgentMessage: (text: string) => console.log("Agent message:", text),
    targetBranch: "main",
  },
};

/** Full design state — title + repo/branch + Review + Merge */
export const TitleWithPR: Story = {
  args: {
    title: "Restart Dev Server",
    repositoryName: "sample-backend",
    branch: "restart-dev-server",
    workspacePath: "/tmp/workspace",
    prStatus: {
      has_pr: true,
      pr_number: 42,
      pr_title: "feat: restart expo server command",
      pr_url: "https://github.com/org/repo/pull/42",
      merge_status: "ready",
    },
    onReviewPR: () => console.log("Review PR"),
    onSendAgentMessage: (text: string) => console.log("Agent message:", text),
    targetBranch: "main",
  },
};

/** Minimal — only repo name, no actions */
export const MinimalRepoOnly: Story = {
  args: {
    repositoryName: "hive-ide",
  },
};
