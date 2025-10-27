import { FolderOpen } from 'lucide-react';
import { EmptyState } from '@/components/ui';
import type { Workspace } from '@/shared/types';

interface FileBrowserPanelProps {
  selectedWorkspace: Workspace | null;
}

/**
 * FileBrowserPanel - Browse all files in workspace directory
 *
 * TODO: Implement full file tree browser when backend API is available
 * - Fetch file tree structure from backend
 * - Display as tree view with folders and files
 * - Click to view/open files
 * - Respect .gitignore
 */
export function FileBrowserPanel({ selectedWorkspace }: FileBrowserPanelProps) {
  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex-1 flex items-center justify-center p-8">
        {selectedWorkspace ? (
          <EmptyState
            icon={<FolderOpen />}
            description="File browser coming soon"
          />
        ) : (
          <EmptyState
            icon={<FolderOpen />}
            description="Select a workspace to browse files"
          />
        )}
      </div>
    </div>
  );
}
