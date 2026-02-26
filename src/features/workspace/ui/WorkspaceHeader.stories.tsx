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
  },
};
export default meta;

type Story = StoryObj<typeof WorkspaceHeader>;

/** Default — repo name + branch + Open button */
export const Default: Story = {
  args: {
    repositoryName: "echo-backend",
    branch: "zvadaadam/fix-api-keys",
    workspacePath: "/tmp/workspace",
  },
};

/** Title with repo/branch */
export const WithTitle: Story = {
  args: {
    title: "Restart Expo Server",
    repositoryName: "echo-backend",
    branch: "restart-expo-server",
    workspacePath: "/tmp/workspace",
  },
};

/** Setup running — shows spinner */
export const SetupRunning: Story = {
  args: {
    repositoryName: "echo-backend",
    branch: "main",
    workspacePath: "/tmp/workspace",
    setupStatus: "running",
  },
};

/** Setup failed — shows error + retry actions */
export const SetupFailed: Story = {
  args: {
    repositoryName: "echo-backend",
    branch: "main",
    workspacePath: "/tmp/workspace",
    setupStatus: "failed",
    setupError: "npm install failed with exit code 1",
    onRetrySetup: () => console.log("Retry setup"),
    onViewSetupLogs: () => console.log("View logs"),
    onSendAgentMessage: (text: string) => console.log("Agent message:", text),
  },
};

/** Minimal — only repo name */
export const MinimalRepoOnly: Story = {
  args: {
    repositoryName: "hive-ide",
  },
};
