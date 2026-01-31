import { useState } from "react";
import type { FallbackProps } from "react-error-boundary";
import { Button } from "@/components/ui/button";

/**
 * Dashboard-specific error fallback UI.
 * Shown when the Dashboard/MainLayout component crashes.
 * Uses FallbackProps to integrate with react-error-boundary.
 */
export function DashboardError({ error, resetErrorBoundary }: FallbackProps) {
  const [copied, setCopied] = useState(false);

  async function copyErrorDetails() {
    if (!error) return;
    const details = [
      `Message: ${error.message}`,
      error.stack ? `\nStack:\n${error.stack}` : "",
    ].join("\n");

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(details);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = details;
        textarea.setAttribute("readonly", "true");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Swallow copy errors; user can still read details.
    }
  }

  return (
    <div className="bg-background text-foreground flex min-h-screen items-center justify-center p-6">
      <div className="bg-card/60 border-border/60 w-full max-w-xl rounded-2xl border p-6 shadow-sm backdrop-blur">
        <div className="flex items-start gap-4">
          <div className="bg-primary/10 text-primary flex h-12 w-12 items-center justify-center rounded-full">
            <span className="text-xl" aria-hidden="true">
              &#x1F4CA;
            </span>
          </div>
          <div className="flex-1">
            <h2 className="text-xl font-semibold">Dashboard Error</h2>
            <p className="text-muted-foreground mt-1">
              The dashboard hit a problem while loading your workspaces. This might be temporary.
            </p>
          </div>
        </div>

        {error && (
          <details className="mt-5 text-left">
            <summary className="bg-muted/60 hover:bg-muted cursor-pointer rounded-lg px-3 py-2 text-sm font-medium">
              Error details
            </summary>
            <div className="bg-muted/50 max-h-56 overflow-auto rounded-lg p-4 font-mono text-xs">
              <div className="mb-3 flex items-center justify-end">
                <Button size="sm" variant="outline" onClick={copyErrorDetails}>
                  {copied ? "Copied" : "Copy details"}
                </Button>
              </div>
              <strong className="text-foreground">Message:</strong>
              <pre className="text-foreground/90 mt-2 whitespace-pre-wrap">{error.message}</pre>
              {import.meta.env.DEV && error.stack && (
                <>
                  <strong className="text-foreground mt-4 block">Stack trace:</strong>
                  <pre className="text-muted-foreground mt-2 whitespace-pre-wrap">
                    {error.stack}
                  </pre>
                </>
              )}
            </div>
          </details>
        )}

        <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
          <Button onClick={resetErrorBoundary}>Try Again</Button>
          <Button onClick={() => (window.location.href = "/")} variant="outline">
            Reload Dashboard
          </Button>
        </div>
      </div>
    </div>
  );
}
