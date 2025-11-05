/**
 * Language Detection Utility
 *
 * Detects programming language from file extensions
 * Used across tool renderers for syntax highlighting
 */

/**
 * Detects language from file path extension
 */
export function detectLanguageFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();

  const languageMap: Record<string, string> = {
    // TypeScript/JavaScript
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",

    // Python
    py: "python",
    pyw: "python",

    // Rust
    rs: "rust",

    // Go
    go: "go",

    // Java/Kotlin
    java: "java",
    kt: "kotlin",
    kts: "kotlin",

    // C/C++
    c: "c",
    cpp: "cpp",
    cc: "cpp",
    cxx: "cpp",
    h: "c",
    hpp: "cpp",

    // Web
    html: "html",
    htm: "html",
    css: "css",
    scss: "scss",
    sass: "sass",
    less: "less",

    // Config/Data
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    xml: "xml",

    // Shell
    sh: "bash",
    bash: "bash",
    zsh: "zsh",

    // Markdown
    md: "markdown",
    mdx: "markdown",

    // Other
    sql: "sql",
    rb: "ruby",
    php: "php",
    swift: "swift",
  };

  return languageMap[ext || ""] || "text";
}
