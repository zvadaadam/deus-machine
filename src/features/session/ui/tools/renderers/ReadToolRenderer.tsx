/**
 * Read Tool Renderer (REFACTORED with BaseToolRenderer)
 *
 * Specialized renderer for the Read tool (reading file contents).
 *
 * BEFORE: 115 LOC (header, animation, error, syntax highlighting)
 * AFTER: ~35 LOC (only unique syntax highlighting logic!)
 */

import { FileText } from 'lucide-react';
import { BaseToolRenderer, CodeBlock, FilePathDisplay } from '../components';
import type { ToolRendererProps } from '../../chat-types';
import { detectLanguageFromPath } from '../utils/detectLanguage';

export function ReadToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const { file_path, offset, limit } = toolUse.input;

  return (
    <BaseToolRenderer
      toolName="Read File"
      icon={<FileText className="w-4 h-4 text-info" />}
      toolUse={toolUse}
      toolResult={toolResult}
      defaultExpanded={false} // Collapsed by default for Read
      borderColor="info"
      renderMetadata={() => (
        <div className="space-y-1">
          <FilePathDisplay path={file_path} />
          {/* Range info */}
          {(offset !== undefined || limit !== undefined) && (
            <div className="px-2 text-xs text-muted-foreground">
              {offset !== undefined && `Offset: ${offset}`}
              {offset !== undefined && limit !== undefined && ' • '}
              {limit !== undefined && `Limit: ${limit} ${Number(limit) === 1 ? 'line' : 'lines'}`}
            </div>
          )}
        </div>
      )}
      renderSummary={() => <span>{file_path}</span>}
      renderContent={({ toolResult }) => {
        if (!toolResult || toolResult.is_error) return null;

        return (
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">Content:</div>
            <CodeBlock
              code={
                typeof toolResult.content === 'object'
                  ? JSON.stringify(toolResult.content, null, 2)
                  : toolResult.content
              }
              language={detectLanguageFromPath(file_path)}
              showLineNumbers={true}
              maxHeight="400px"
            />
          </div>
        );
      }}
    />
  );
}
