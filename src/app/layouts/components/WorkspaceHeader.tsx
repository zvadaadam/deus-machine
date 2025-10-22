import { SidebarTrigger } from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';
import { BranchName, OpenInDropdown } from '@/shared/components';

interface WorkspaceHeaderProps {
  branch: string;
  workspacePath: string;
}

export function WorkspaceHeader({ branch, workspacePath }: WorkspaceHeaderProps) {
  return (
    <div className="border-b border-border/60 bg-background/50 backdrop-blur-sm px-4 py-3 elevation-1 flex-shrink-0">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="h-4" />
          <BranchName branch={branch} />
        </div>
        <OpenInDropdown workspacePath={workspacePath} />
      </div>
    </div>
  );
}
