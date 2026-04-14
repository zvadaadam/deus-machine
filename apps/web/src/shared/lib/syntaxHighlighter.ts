/**
 * Syntax Highlighting Utility with Shiki
 *
 * Provides code syntax highlighting for FileViewer, tool output, and chat code blocks.
 * Uses a singleton highlighter with lazy language loading — core languages are loaded
 * eagerly, additional languages are loaded on-demand via ensureLanguage().
 */

import { createHighlighter, type Highlighter, type BundledLanguage } from "shiki";

let highlighterInstance: Highlighter | null = null;
let highlighterPromise: Promise<Highlighter> | null = null;

// Loaded eagerly at init — covers ~90% of code blocks in an IDE context
const CORE_LANGS: BundledLanguage[] = [
  "typescript",
  "javascript",
  "tsx",
  "jsx",
  "python",
  "rust",
  "go",
  "java",
  "c",
  "cpp",
  "html",
  "css",
  "scss",
  "json",
  "yaml",
  "toml",
  "bash",
  "sql",
  "markdown",
  "ruby",
  "php",
  "swift",
];

// Track in-flight language loads to avoid duplicate requests
const pendingLangLoads = new Map<string, Promise<void>>();

/**
 * Initialize or get cached Shiki highlighter instance.
 * Race condition prevention: concurrent calls share the same promise.
 */
async function getHighlighter(): Promise<Highlighter> {
  if (highlighterInstance) return highlighterInstance;
  if (highlighterPromise) return highlighterPromise;

  highlighterPromise = createHighlighter({
    themes: ["github-dark", "github-light"],
    langs: CORE_LANGS,
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
 * Ensure a language is loaded, lazy-loading it if necessary.
 * Returns the resolved language name to use ("text" if unsupported).
 */
async function ensureLanguage(highlighter: Highlighter, language: string): Promise<string> {
  const loaded = highlighter.getLoadedLanguages() as string[];
  if (loaded.includes(language)) return language;

  // Try lazy-loading the language
  if (!pendingLangLoads.has(language)) {
    const loadPromise = highlighter
      .loadLanguage(language as BundledLanguage)
      .then(() => {
        pendingLangLoads.delete(language);
      })
      .catch(() => {
        pendingLangLoads.delete(language);
      });
    pendingLangLoads.set(language, loadPromise);
  }

  await pendingLangLoads.get(language);

  // Check if it loaded successfully
  const nowLoaded = highlighter.getLoadedLanguages() as string[];
  return nowLoaded.includes(language) ? language : "text";
}

/**
 * Highlight code and return only the inner token HTML (no <pre>/<code> wrappers).
 * Used by chat code blocks where the wrapper elements already exist.
 *
 * Extracts Shiki's base foreground color from the <pre> element and wraps
 * tokens so un-styled text inherits the correct theme color (not CSS fallback).
 */
export async function highlightCodeTokens(
  code: string,
  language: string,
  theme: "github-dark" | "github-light" = "github-dark"
): Promise<string | null> {
  try {
    const highlighter = await getHighlighter();
    const lang = await ensureLanguage(highlighter, language);
    const html = highlighter.codeToHtml(code, { lang, theme });

    // Extract inner content: <pre ...><code ...>{TOKENS}</code></pre>
    const codeMatch = html.match(/<code[^>]*>([\s\S]*?)<\/code>/);
    if (!codeMatch) return null;

    // Extract base foreground color from <pre> (Shiki sets theme fg there)
    const preStyle = html.match(/<pre[^>]*style="([^"]*)"/);
    const fgMatch = preStyle?.[1].match(/(?:^|;)\s*color:(#[0-9a-fA-F]+)/);
    const fg = fgMatch?.[1];

    // Strip only background-color properties, preserve color on same span
    let tokens = codeMatch[1].replace(/background-color:[^;"]*;?/gi, "");

    // Wrap with base foreground so un-styled tokens inherit the theme color
    if (fg) {
      tokens = `<span style="color:${fg}">${tokens}</span>`;
    }

    return tokens;
  } catch {
    return null;
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
    const lang = await ensureLanguage(highlighter, language);

    const html = highlighter.codeToHtml(content, { lang, theme });

    // Extract inner <code> content
    const codeMatch = html.match(/<code[^>]*>([\s\S]*?)<\/code>/);
    if (!codeMatch) return lines.map(escapeHtml);

    let codeHtml = codeMatch[1];
    // Strip background styles
    codeHtml = codeHtml.replace(/background-color:[^;"]*;?/gi, "");

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
