/**
 * LazyMermaidDiagram - Lazy-loading wrapper for MermaidDiagram
 *
 * Splits mermaid (~500KB) into a separate chunk loaded on first encounter.
 * Fallback shows the raw mermaid code so there's no layout shift.
 */

import { lazy, Suspense } from "react";

const MermaidDiagram = lazy(() => import("./MermaidDiagram"));

function MermaidFallback({ chart }: { chart: string }) {
  return (
    <div className="my-3">
      <div className="text-muted-foreground/50 mb-1.5 flex items-center gap-1.5 text-xs">
        <div className="border-muted-foreground/20 border-t-muted-foreground/50 h-3 w-3 animate-spin rounded-full border-[1.5px]" />
        <span>Rendering diagram...</span>
      </div>
      <pre className="border-border/50 bg-muted/30 overflow-x-auto rounded-lg border p-3 text-xs opacity-60">
        <code>{chart}</code>
      </pre>
    </div>
  );
}

export function LazyMermaidDiagram({ chart }: { chart: string }) {
  return (
    <Suspense fallback={<MermaidFallback chart={chart} />}>
      <MermaidDiagram chart={chart} />
    </Suspense>
  );
}
