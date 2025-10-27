import { Globe } from 'lucide-react';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { BranchName, OpenInDropdown } from '@/shared/components';

interface WorkspaceHeaderProps {
  branch: string;
  workspacePath: string;
  onBrowserToggle?: () => void;
  showBrowserButton?: boolean;
}

export function WorkspaceHeader({
  branch,
  workspacePath,
  onBrowserToggle,
  showBrowserButton = true
}: WorkspaceHeaderProps) {
  return (
    <div className="border-b border-border/60 bg-background/50 backdrop-blur-sm px-4 py-3 elevation-1 flex-shrink-0">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="h-4" />
          <BranchName branch={branch} />
        </div>
        <div className="flex items-center gap-2">
          {showBrowserButton && onBrowserToggle && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={onBrowserToggle}
                className="gap-2"
                title="Open browser"
              >
                <Globe className="h-4 w-4" />
                <span className="text-sm">Browser</span>
              </Button>
              <Separator orientation="vertical" className="h-4" />
            </>
          )}
          <OpenInDropdown workspacePath={workspacePath} />
        </div>
      </div>
    </div>
  );
}
