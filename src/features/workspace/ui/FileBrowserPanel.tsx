import { FolderOpen } from 'lucide-react';
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
    <div className="h-full flex flex-col items-center justify-center p-8">
      <div className="flex flex-col items-center gap-2">
        <FolderOpen className="h-8 w-8 text-muted-foreground/40" />
        <p className="text-xs text-muted-foreground/60">
          {selectedWorkspace ? 'File browser' : 'No workspace selected'}
        </p>
      </div>
    </div>
  );
}
