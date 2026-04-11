/**
 * HtmlPreviewBlock - Renders live HTML+CSS inside a Shadow DOM
 *
 * Agents can write `html-preview` code fences to show live component previews
 * directly in chat. Styles are fully scoped via Shadow DOM — nothing leaks in or out.
 * All JavaScript is stripped (scripts, event handlers, javascript: URIs) for safety.
 *
 * Follows the same integration pattern as MermaidDiagram (code fence → custom renderer).
 * Unlike LazyMermaidDiagram, this is eagerly loaded — no heavy runtime dependencies.
 */

import { useRef, useEffect, useState } from "react";

/** Elements that create nested browsing contexts capable of executing scripts */
const BLOCKED_ELEMENTS = new Set([
  "script",
  "iframe",
  "object",
  "embed",
  "frame",
  "frameset",
  "portal",
  "base",
]);

/** Attributes that carry URIs which could execute code or load external content */
const URI_ATTRS = new Set(["href", "src", "action", "formaction", "data", "srcdoc", "xlink:href"]);

/** Matches dangerous URI schemes that can execute scripts */
const DANGEROUS_URI = /^\s*(javascript|data\s*:\s*text\/html)\s*:/i;

/**
 * Sanitize HTML using DOMParser. Strips all JavaScript execution vectors:
 * - Elements that create nested browsing contexts (script, iframe, object, embed, etc.)
 * - on* event handler attributes (onclick, onerror, onload, etc.)
 * - Dangerous URI schemes in link/resource attributes (javascript:, data:text/html)
 */
function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");

  // Remove all elements that can create nested browsing contexts or execute code
  for (const el of Array.from(doc.body.querySelectorAll("*"))) {
    if (BLOCKED_ELEMENTS.has(el.tagName.toLowerCase())) {
      el.remove();
    }
  }

  // Strip dangerous attributes from remaining elements
  for (const el of Array.from(doc.body.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();

      if (name.startsWith("on") || name === "srcdoc") {
        el.removeAttribute(attr.name);
        continue;
      }

      if (URI_ATTRS.has(name) && DANGEROUS_URI.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  }

  return doc.body.innerHTML;
}

/**
 * Extract <style> blocks from HTML, return sanitized styles and remaining body separately.
 * Strips external resource loads (url() with non-data: origins) to prevent exfiltration.
 */
function extractStyles(html: string): { styles: string; body: string } {
  const styleBlocks: string[] = [];
  const body = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_, css) => {
    styleBlocks.push(css);
    return "";
  });

  // Strip url() calls that aren't data: URIs (prevents @import, font-face, background exfiltration)
  const sanitizedStyles = styleBlocks
    .join("\n")
    .replace(/url\(\s*(?!['"]?data:)['"]?[^)]*['"]?\s*\)/gi, "url()")
    .replace(/@import\s+[^;]*;/gi, "");

  return { styles: sanitizedStyles, body: body.trim() };
}

/** Build a small CSS reset that sets sensible defaults inside the shadow root */
function buildThemeDefaults(): string {
  return `:host { display: block; }
* { box-sizing: border-box; }
:root, body, div { color: var(--foreground); background: transparent; font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.5; }`;
}

const THEME_CSS = buildThemeDefaults();
const RENDER_DEBOUNCE_MS = 120;

interface HtmlPreviewBlockProps {
  code: string;
}

export function HtmlPreviewBlock({ code }: HtmlPreviewBlockProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<ShadowRoot | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    clearTimeout(timerRef.current);

    timerRef.current = setTimeout(() => {
      if (!containerRef.current) return;

      try {
        // Attach shadow root once — re-attach if the host element changed (error → success swap)
        if (!shadowRef.current || shadowRef.current.host !== containerRef.current) {
          shadowRef.current = containerRef.current.attachShadow({ mode: "open" });
        }

        const { styles, body } = extractStyles(code);
        const safeBody = sanitizeHtml(body);

        shadowRef.current.innerHTML = `<style>${THEME_CSS}\n${styles}</style><div>${safeBody}</div>`;
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to render preview");
      }
    }, RENDER_DEBOUNCE_MS);

    return () => clearTimeout(timerRef.current);
  }, [code]);

  if (error) {
    return (
      <div className="my-3">
        <div className="text-muted-foreground/70 mb-1.5 flex items-center gap-1.5 text-xs">
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span>Preview error</span>
        </div>
        <pre className="border-border/50 bg-muted/30 overflow-x-auto rounded-lg border p-3 text-xs">
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  return (
    <div className="my-3">
      <div className="text-muted-foreground/70 mb-1.5 flex items-center gap-1.5 text-xs">
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        <span>Preview</span>
      </div>
      <div className="border-border/50 bg-muted/30 overflow-hidden rounded-lg border">
        <div ref={containerRef} className="p-4" />
      </div>
    </div>
  );
}
