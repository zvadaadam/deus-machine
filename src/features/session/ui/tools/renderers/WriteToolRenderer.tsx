/**
 * Write Tool Renderer (REFACTORED with BaseToolRenderer)
 *
 * Specialized renderer for the Write tool (creating new files).
 *
 * BEFORE: 105 LOC (header, animation, error, code preview)
 * AFTER: ~30 LOC (only unique code preview logic!)
 */

import { FilePlus } from 'lucide-react';
import { BaseToolRenderer, CodeBlock, FilePathDisplay } from '../components';
import type { ToolRendererProps } from '../../chat-types';
import { detectLanguageFromPath } from '../utils/detectLanguage';

export function WriteToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { file_path, content } = toolUse.input;

  return (
    <BaseToolRenderer
      toolName="Write File"
      icon={<FilePlus className="w-4 h-4 text-success" />}
      toolUse={toolUse}
      toolResult={toolResult}
      defaultExpanded={true}
      borderColor="success"
      backgroundColor="bg-success/5"
      renderMetadata={() => <FilePathDisplay path={file_path} />}
      renderContent={() => (
        <div>
          <div className="text-xs text-muted-foreground mb-1">Content:</div>
          <CodeBlock
            code={content}
            language={detectLanguageFromPath(file_path)}
            showLineNumbers={true}
            maxHeight="300px"
          />
        </div>
      )}
    />
  );
}
