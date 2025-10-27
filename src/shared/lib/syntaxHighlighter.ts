/**
 * Syntax Highlighting Utility with Shiki
 *
 * Provides code syntax highlighting for diffs and code blocks
 * using Shiki (VS Code's syntax highlighter)
 */

import { createHighlighter, type Highlighter } from 'shiki';

let highlighterInstance: Highlighter | null = null;

/**
 * Initialize or get cached Shiki highlighter instance
 * Uses GitHub Dark theme to match our dark UI
 */
export async function getHighlighter(): Promise<Highlighter> {
  if (highlighterInstance) {
    return highlighterInstance;
  }

  highlighterInstance = await createHighlighter({
    themes: ['github-dark', 'github-light'],
    langs: [
      'typescript', 'javascript', 'tsx', 'jsx',
      'python', 'rust', 'go', 'java',
      'html', 'css', 'json', 'yaml',
      'bash', 'sql', 'markdown',
    ],
  });

  return highlighterInstance;
}

/**
 * Highlight code string with syntax highlighting
 * Returns HTML string with inline styles
 *
 * @param code - Code to highlight
 * @param language - Language identifier (typescript, javascript, etc.)
 * @param theme - Theme to use ('github-dark' or 'github-light')
 */
export async function highlightCode(
  code: string,
  language: string,
  theme: 'github-dark' | 'github-light' = 'github-dark'
): Promise<string> {
  try {
    const highlighter = await getHighlighter();

    // Check if language is supported, fallback to plaintext
    const supportedLangs = highlighter.getLoadedLanguages();
    const lang = supportedLangs.includes(language as any) ? language : 'text';

    const html = highlighter.codeToHtml(code, {
      lang,
      theme,
    });

    return html;
  } catch (error) {
    console.error('Syntax highlighting failed:', error);
    return `<pre><code>${escapeHtml(code)}</code></pre>`;
  }
}

/**
 * Parse git diff and extract code hunks with line numbers
 * Filters out git metadata (diff --git, index, +++, ---)
 * Returns structured code blocks ready for display
 */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffLine {
  type: 'addition' | 'deletion' | 'context';
  content: string;
  oldLineNum?: number;
  newLineNum?: number;
}

export function parseDiff(diffText: string): DiffHunk[] {
  const lines = diffText.split('\n');
  const hunks: DiffHunk[] = [];
  let currentHunk: DiffHunk | null = null;
  let oldLineNum = 0;
  let newLineNum = 0;

  for (const line of lines) {
    // Skip git metadata - everything that's not actual code
    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('---') ||
      line.startsWith('+++') ||
      line.startsWith('new file mode') ||
      line.startsWith('deleted file mode') ||
      line.startsWith('old mode') ||
      line.startsWith('new mode') ||
      line.startsWith('similarity index') ||
      line.startsWith('rename from') ||
      line.startsWith('rename to') ||
      line.startsWith('Binary files')
    ) {
      continue;
    }

    // Parse hunk header: @@ -oldStart,oldLines +newStart,newLines @@
    if (line.startsWith('@@')) {
      // Save previous hunk
      if (currentHunk) {
        hunks.push(currentHunk);
      }

      // Parse line numbers from @@ -10,5 +12,7 @@
      const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (match) {
        const oldStart = parseInt(match[1], 10);
        const oldLines = match[2] ? parseInt(match[2], 10) : 1;
        const newStart = parseInt(match[3], 10);
        const newLines = match[4] ? parseInt(match[4], 10) : 1;

        currentHunk = {
          oldStart,
          oldLines,
          newStart,
          newLines,
          lines: [],
        };

        oldLineNum = oldStart;
        newLineNum = newStart;
      }
      continue;
    }

    // Process code lines (additions, deletions, context)
    if (currentHunk) {
      if (line.startsWith('+')) {
        currentHunk.lines.push({
          type: 'addition',
          content: line.slice(1), // Remove + prefix
          newLineNum: newLineNum++,
        });
      } else if (line.startsWith('-')) {
        currentHunk.lines.push({
          type: 'deletion',
          content: line.slice(1), // Remove - prefix
          oldLineNum: oldLineNum++,
        });
      } else {
        // Context line (starts with space or empty)
        currentHunk.lines.push({
          type: 'context',
          content: line.startsWith(' ') ? line.slice(1) : line,
          oldLineNum: oldLineNum++,
          newLineNum: newLineNum++,
        });
      }
    }
  }

  // Save last hunk
  if (currentHunk) {
    hunks.push(currentHunk);
  }

  return hunks;
}

/**
 * Highlight a single line of code with syntax highlighting
 * Used for rendering individual diff lines
 */
export async function highlightDiffLine(
  content: string,
  language: string,
  theme: 'github-dark' | 'github-light' = 'github-dark'
): Promise<string> {
  // For empty lines, return empty space
  if (content.trim().length === 0) {
    return '&nbsp;';
  }

  try {
    const highlighter = await getHighlighter();
    const supportedLangs = highlighter.getLoadedLanguages();
    const lang = supportedLangs.includes(language as any) ? language : 'text';

    const html = highlighter.codeToHtml(content, {
      lang,
      theme,
    });

    // Extract only the <code> content, remove <pre> wrapper
    const codeMatch = html.match(/<code[^>]*>(.*?)<\/code>/s);
    let highlightedCode = codeMatch ? codeMatch[1] : escapeHtml(content);

    // Remove shiki's default background (we handle backgrounds ourselves)
    highlightedCode = highlightedCode.replace(/style="[^"]*background[^"]*"/gi, '');

    return highlightedCode;
  } catch (error) {
    console.error('Diff line highlighting failed:', error);
    return escapeHtml(content);
  }
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
