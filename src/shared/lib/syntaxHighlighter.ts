/**
 * Syntax Highlighting Utility with Shiki
 *
 * Provides code syntax highlighting for the FileViewer component.
 * Diff rendering is now handled by @pierre/diffs.
 */

import { createHighlighter, type Highlighter } from "shiki";

let highlighterInstance: Highlighter | null = null;
let highlighterPromise: Promise<Highlighter> | null = null;

/**
 * Initialize or get cached Shiki highlighter instance
 *
 * Race condition prevention: Multiple concurrent calls share the same promise
 * to avoid creating duplicate highlighter instances
 */
export async function getHighlighter(): Promise<Highlighter> {
  if (highlighterInstance) {
    return highlighterInstance;
  }

  if (highlighterPromise) {
    return highlighterPromise;
  }

  highlighterPromise = createHighlighter({
    themes: ["github-dark", "github-light"],
    langs: [
      "typescript",
      "javascript",
      "tsx",
      "jsx",
      "python",
      "rust",
      "go",
      "java",
      "html",
      "css",
      "json",
      "yaml",
      "bash",
      "sql",
      "markdown",
    ],
  })
    .then((highlighter) => {
      highlighterInstance = highlighter;
      return highlighter;
    })
    .catch((err) => {
      highlighterPromise = null;
      throw err;
    });

  return highlighterPromise;
}

/**
 * Highlight code string with syntax highlighting
 * Returns HTML string with inline styles
 */
export async function highlightCode(
  code: string,
  language: string,
  theme: "github-dark" | "github-light" = "github-dark"
): Promise<string> {
  try {
    const highlighter = await getHighlighter();
    const supportedLangs = highlighter.getLoadedLanguages();
    const lang = (supportedLangs as string[]).includes(language) ? language : "text";

    const html = highlighter.codeToHtml(code, { lang, theme });
    return html;
  } catch (error) {
    console.error("Syntax highlighting failed:", error);
    return `<pre><code>${escapeHtml(code)}</code></pre>`;
  }
}

/**
 * Highlight a single line of code — used by FileViewer for per-line rendering
 */
export async function highlightDiffLine(
  content: string,
  language: string,
  theme: "github-dark" | "github-light" = "github-dark"
): Promise<string> {
  if (content.trim().length === 0) {
    return "&nbsp;";
  }

  try {
    const highlighter = await getHighlighter();
    const supportedLangs = highlighter.getLoadedLanguages();
    const lang = (supportedLangs as string[]).includes(language) ? language : "text";

    const html = highlighter.codeToHtml(content, { lang, theme });

    const codeMatch = html.match(/<code[^>]*>(.*?)<\/code>/s);
    let highlightedCode = codeMatch ? codeMatch[1] : escapeHtml(content);
    highlightedCode = highlightedCode.replace(/style="[^"]*background[^"]*"/gi, "");

    return highlightedCode;
  } catch (error) {
    console.error("Line highlighting failed:", error);
    return escapeHtml(content);
  }
}

/**
 * Highlight an entire file and return per-line HTML strings.
 * Single codeToHtml call instead of N per-line calls (orders of magnitude faster).
 */
export async function highlightFileLines(
  content: string,
  language: string,
  theme: "github-dark" | "github-light" = "github-dark"
): Promise<string[]> {
  const lines = content.split("\n");
  if (lines.length === 0) return [];

  try {
    const highlighter = await getHighlighter();
    const supportedLangs = highlighter.getLoadedLanguages();
    const lang = (supportedLangs as string[]).includes(language) ? language : "text";

    const html = highlighter.codeToHtml(content, { lang, theme });

    // Extract inner <code> content
    const codeMatch = html.match(/<code[^>]*>([\s\S]*?)<\/code>/);
    if (!codeMatch) return lines.map(escapeHtml);

    let codeHtml = codeMatch[1];
    // Strip background styles
    codeHtml = codeHtml.replace(/style="[^"]*background[^"]*"/gi, "");

    // Shiki wraps each line in <span class="line">...</span>
    const lineHtmls = codeHtml
      .split(/<span class="line">/)
      .slice(1) // first split element is empty
      .map((chunk) => {
        // Remove trailing </span> that closes the line wrapper
        const closingIdx = chunk.lastIndexOf("</span>");
        return closingIdx >= 0 ? chunk.slice(0, closingIdx) : chunk;
      });

    // Pad with empty lines if Shiki produced fewer lines than source
    return lines.map((line, i) => {
      if (i < lineHtmls.length && lineHtmls[i]) return lineHtmls[i];
      return line.trim().length === 0 ? "&nbsp;" : escapeHtml(line);
    });
  } catch (error) {
    console.error("File highlighting failed:", error);
    return lines.map((line) => (line.trim().length === 0 ? "&nbsp;" : escapeHtml(line)));
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
