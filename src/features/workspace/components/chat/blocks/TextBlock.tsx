/**
 * Text Block
 *
 * Renders plain text content blocks from Claude messages
 */

import type { TextBlock as TextBlockType } from '@/types';
import { chatTheme } from '../theme';

interface TextBlockProps {
  block: TextBlockType | string;
}

export function TextBlock({ block }: TextBlockProps) {
  // Handle both TextBlock objects and plain strings
  const text = typeof block === 'string' ? block : block.text;

  if (!text || text.trim() === '') {
    return null;
  }

  return (
    <div className={chatTheme.blocks.text.container}>
      <p className={chatTheme.blocks.text.content}>
        {text}
      </p>
    </div>
  );
}
