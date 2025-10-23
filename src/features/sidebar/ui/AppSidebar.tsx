import {
  Sidebar,
  SidebarContent,
  SidebarMenu,
  useSidebar,
} from "@/components/ui/sidebar";
import { useUIStore } from "@/shared/stores/uiStore";
import { useSidebarStore } from "../store/sidebarStore";
import type { AppSidebarProps } from "../model/types";
import { RepositoryItem } from "./RepositoryItem";
import { SidebarHeader } from "./SidebarHeader";
import { SidebarFooter } from "./SidebarFooter";

export function AppSidebar({
  repositories,
  selectedWorkspaceId,
  diffStats,
  onWorkspaceClick,
  onNewWorkspace,
  onAddRepository,
  onArchive,
  profile = { username: "User" },
}: AppSidebarProps) {
  const { state } = useSidebar();
  const { openSettingsModal } = useUIStore();
  const { collapsedRepos, toggleRepoCollapse } = useSidebarStore();

  const isExpanded = state === "expanded";

  return (
    <Sidebar variant="inset" collapsible="icon">
      <SidebarHeader profile={profile} onOpenSettings={openSettingsModal} />

      {/* Repositories List */}
      <SidebarContent className="group-data-[collapsible=icon]:overflow-visible">
        <SidebarMenu className="p-2 gap-2">
          {repositories.map((repo) => (
            <RepositoryItem
              key={repo.repo_id}
              repository={repo}
              isCollapsed={collapsedRepos.has(repo.repo_id)}
              selectedWorkspaceId={selectedWorkspaceId}
              diffStats={diffStats}
              onToggleCollapse={() => toggleRepoCollapse(repo.repo_id)}
              onWorkspaceClick={onWorkspaceClick}
              onNewWorkspace={onNewWorkspace}
              onArchive={onArchive}
              sidebarExpanded={isExpanded}
            />
          ))}
        </SidebarMenu>
      </SidebarContent>

      <SidebarFooter onAddRepository={onAddRepository} />
    </Sidebar>
  );
}
