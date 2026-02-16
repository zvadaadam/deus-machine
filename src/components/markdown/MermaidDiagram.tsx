/**
 * MermaidDiagram - Renders mermaid syntax into SVG diagrams
 *
 * Lazy-loaded via LazyMermaidDiagram.tsx to avoid adding ~500KB to initial bundle.
 * Uses mermaid.render() API for programmatic SVG generation (no DOM parsing).
 * Automatically switches between dark/default theme based on app theme.
 */

import { useEffect, useId, useState } from "react";
import mermaid from "mermaid";
import { useTheme } from "@/app/providers/ThemeProvider";
import { cn } from "@/shared/lib/utils";

interface MermaidDiagramProps {
  chart: string;
}

let mermaidInitialized = false;
let lastTheme: string | null = null;

function initMermaid(theme: "light" | "dark") {
  const mermaidTheme = theme === "dark" ? "dark" : "default";
  if (mermaidInitialized && lastTheme === mermaidTheme) return;

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: mermaidTheme,
    fontFamily: "inherit",
  });
  mermaidInitialized = true;
  lastTheme = mermaidTheme;
}

export default function MermaidDiagram({ chart }: MermaidDiagramProps) {
  const { actualTheme } = useTheme();
  const instanceId = useId();
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Sanitize the ID for mermaid (no colons from useId)
  const diagramId = `mermaid-${instanceId.replace(/:/g, "")}`;

  useEffect(() => {
    let cancelled = false;

    async function renderDiagram() {
      try {
        initMermaid(actualTheme);
        const { svg: renderedSvg } = await mermaid.render(diagramId, chart);
        if (!cancelled) {
          setSvg(renderedSvg);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setSvg(null);
          setError(err instanceof Error ? err.message : "Failed to render diagram");
        }
        // Clean up any orphaned element mermaid may have created
        const orphan = document.getElementById("d" + diagramId);
        orphan?.remove();
      }
    }

    renderDiagram();
    return () => {
      cancelled = true;
    };
  }, [chart, actualTheme, diagramId]);

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
          <span>Diagram syntax error</span>
        </div>
        <pre className="border-border/50 bg-muted/30 overflow-x-auto rounded-lg border p-3 text-xs">
          <code>{chart}</code>
        </pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="border-border/50 bg-muted/30 my-3 flex items-center justify-center rounded-lg border p-6">
        <div className="border-muted-foreground/30 border-t-muted-foreground h-4 w-4 animate-spin rounded-full border-2" />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "border-border/50 bg-muted/30 my-3 overflow-x-auto rounded-lg border p-4",
        "[&_svg]:mx-auto [&_svg]:max-w-full"
      )}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
