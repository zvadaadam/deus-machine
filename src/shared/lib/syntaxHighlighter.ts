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
 * Highlight diff line with syntax highlighting
 * Parses diff markers (+/-) and applies highlighting to code content
 *
 * @param line - Diff line (e.g., "+ const foo = 'bar'")
 * @param language - Language identifier
 * @param theme - Theme to use
 * @returns Object with { marker: string, highlightedCode: string, type: 'addition' | 'deletion' | 'context' | 'header' }
 */
export async function highlightDiffLine(
  line: string,
  language: string,
  theme: 'github-dark' | 'github-light' = 'github-dark'
): Promise<{
  marker: string;
  highlightedCode: string;
  type: 'addition' | 'deletion' | 'context' | 'header';
  originalLine: string;
}> {
  // Determine line type and extract code content
  let type: 'addition' | 'deletion' | 'context' | 'header';
  let marker = '';
  let codeContent = line;

  if (line.startsWith('+') && !line.startsWith('+++')) {
    type = 'addition';
    marker = '+';
    codeContent = line.slice(1); // Remove + prefix
  } else if (line.startsWith('-') && !line.startsWith('---')) {
    type = 'deletion';
    marker = '−'; // Use proper minus sign (U+2212)
    codeContent = line.slice(1); // Remove - prefix
  } else if (line.startsWith('@@')) {
    type = 'header';
    // Headers don't need highlighting
    return {
      marker: '',
      highlightedCode: escapeHtml(line),
      type,
      originalLine: line,
    };
  } else {
    type = 'context';
    // Context lines: keep as-is (may or may not have leading space)
  }

  // For empty lines, return early
  if (codeContent.trim().length === 0) {
    return {
      marker,
      highlightedCode: '&nbsp;', // Preserve empty line
      type,
      originalLine: line,
    };
  }

  // Highlight the code content (without the +/- marker)
  try {
    const highlighter = await getHighlighter();
    const supportedLangs = highlighter.getLoadedLanguages();
    const lang = supportedLangs.includes(language as any) ? language : 'text';

    const html = highlighter.codeToHtml(codeContent, {
      lang,
      theme,
    });

    // Extract only the <code> content, remove <pre> wrapper
    // Shiki output: <pre class="shiki"><code>highlighted content</code></pre>
    const codeMatch = html.match(/<code[^>]*>(.*?)<\/code>/s);
    let highlightedCode = codeMatch ? codeMatch[1] : escapeHtml(codeContent);

    // Remove shiki's default background (we handle backgrounds ourselves)
    // Replace style attributes to remove background colors
    highlightedCode = highlightedCode.replace(/style="[^"]*background[^"]*"/gi, '');

    return {
      marker,
      highlightedCode,
      type,
      originalLine: line,
    };
  } catch (error) {
    console.error('Diff line highlighting failed:', error);
    return {
      marker,
      highlightedCode: escapeHtml(codeContent),
      type,
      originalLine: line,
    };
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
