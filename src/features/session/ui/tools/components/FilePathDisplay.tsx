/**
 * File Path Display Component
 *
 * Shows file path with icon and proper formatting
 */

import { File, FileCode, FileJson, FileText } from 'lucide-react';
import { cn } from '@/shared/lib/utils';

interface FilePathDisplayProps {
  path: string;
  className?: string;
}

export function FilePathDisplay({ path, className }: FilePathDisplayProps) {
  // Get file icon based on extension
  const getFileIcon = (filePath: string | undefined) => {
    // Guard against undefined path
    if (!filePath) {
      return <FileIcon className="w-4 h-4 flex-shrink-0 text-muted-foreground" aria-hidden />;
    }

    // Extract filename and extension, handling edge cases like .gitignore, Dockerfile
    const fileName = filePath.split('/').pop() || '';
    const dotIndex = fileName.lastIndexOf('.');
    const ext = dotIndex > 0 ? fileName.slice(dotIndex + 1).toLowerCase() : '';

    const iconProps = { className: 'w-4 h-4 flex-shrink-0', 'aria-hidden': true };

    switch (ext) {
      case 'ts':
      case 'tsx':
      case 'js':
      case 'jsx':
      case 'py':
      case 'rs':
      case 'go':
      case 'java':
        return <FileCode {...iconProps} className={cn(iconProps.className, 'text-info')} />;

      case 'json':
      case 'yaml':
      case 'yml':
      case 'toml':
        return <FileJson {...iconProps} className={cn(iconProps.className, 'text-warning')} />;

      case 'md':
      case 'txt':
      case 'log':
        return <FileText {...iconProps} className={cn(iconProps.className, 'text-muted-foreground')} />;

      default:
        return <File {...iconProps} className={cn(iconProps.className, 'text-muted-foreground')} />;
    }
  };

  return (
    <div className={cn('flex items-center gap-2 px-2 py-1.5', className)}>
      {getFileIcon(path)}
      <span className="text-xs font-mono text-muted-foreground break-all">
        {path}
      </span>
    </div>
  );
}
