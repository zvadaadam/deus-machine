/**
 * useFileChangesExtractor Hook
 *
 * Extracts and groups file changes from session messages.
 * Memoized to avoid recomputation on every render.
 *
 * Extracted from SessionPanel to reduce component complexity.
 */

import { useMemo } from 'react';
import type { Message, FileChangeGroup, FileEdit, ContentBlock } from '@/shared/types';

interface UseFileChangesExtractorProps {
  messages: Message[];
  parseContent: (content: string) => (ContentBlock | string)[] | string | null;
}

export function useFileChangesExtractor({
  messages,
  parseContent,
}: UseFileChangesExtractorProps): FileChangeGroup[] {
  return useMemo(() => {
    const fileMap = new Map<string, FileEdit[]>();

    messages.forEach((message) => {
      const contentBlocks = parseContent(message.content);
      if (Array.isArray(contentBlocks)) {
        contentBlocks.forEach((block: any) => {
          if (block?.type === 'tool_use' && (block.name === 'Edit' || block.name === 'Write' || block.name === 'NotebookEdit')) {
            // Support both file_path and notebook_path (for notebook edits)
            const filePath = block.input?.file_path ?? block.input?.notebook_path;
            if (!filePath) return; // Guard against missing file_path or notebook_path

            if (!fileMap.has(filePath)) {
              fileMap.set(filePath, []);
            }

            // Sanitize timestamp to prevent NaN at render
            const tsNum = Date.parse(message.created_at);
            const timestamp = Number.isFinite(tsNum) ? new Date(tsNum).toISOString() : new Date(0).toISOString();

            fileMap.get(filePath)!.push({
              old_string: block.input.old_string,
              new_string: block.input.new_string,
              content: block.input.content,
              timestamp,
              message_id: message.id,
              tool_name: block.name
            });
          }
        });
      }
    });

    const changes: FileChangeGroup[] = Array.from(fileMap.entries()).map(([file_path, edits]) => {
      // Harden timestamp parsing
      const timestamps = edits
        .map(e => Date.parse(e.timestamp))
        .filter((t) => Number.isFinite(t));

      if (!timestamps.length) {
        return {
          file_path,
          edits,
          first_timestamp: new Date(0).toISOString(),
          last_timestamp: new Date(0).toISOString(),
        };
      }

      return {
        file_path,
        edits,
        first_timestamp: new Date(Math.min(...timestamps)).toISOString(),
        last_timestamp: new Date(Math.max(...timestamps)).toISOString()
      };
    });

    changes.sort((a, b) =>
      new Date(b.last_timestamp).getTime() - new Date(a.last_timestamp).getTime()
    );

    return changes;
  }, [messages, parseContent]);
}
