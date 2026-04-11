/**
 * Markdown Components
 *
 * Secure, reusable markdown rendering with Shiki syntax highlighting.
 *
 * - MarkdownRenderer: Core component (use for custom contexts)
 * - ChatMarkdown: Pre-configured for chat messages (dense, IDE-friendly)
 * - LazyMermaidDiagram: Renders mermaid syntax as SVG (lazy-loaded)
 * - HtmlPreviewBlock: Renders live HTML+CSS in Shadow DOM (inline Storybook)
 */

export { MarkdownRenderer } from "./MarkdownRenderer";
export { ChatMarkdown } from "./ChatMarkdown";
export { LazyMermaidDiagram } from "./LazyMermaidDiagram";
export { HtmlPreviewBlock } from "./HtmlPreviewBlock";
