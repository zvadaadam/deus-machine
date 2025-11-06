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
  const fileName = file_path.split('/').pop() || file_path;
  const lineCount = content.split('\n').length;

  return (
    <BaseToolRenderer
      toolName="Write File"
      icon={<FilePlus className="w-4 h-4 text-success/70" />}
      toolUse={toolUse}
      toolResult={toolResult}
      renderSummary={() => (
        <>
          <span className="font-mono text-xs px-2 py-0.5 bg-muted/60 rounded font-medium">
            {fileName}
          </span>
          <span className="text-xs text-muted-foreground"> • {lineCount} lines</span>
        </>
      )}
      renderContent={() => (
        <CodeBlock
          code={content}
          language={detectLanguageFromPath(file_path)}
          showLineNumbers={true}
          maxHeight="300px"
        />
      )}
    />
  );
}
