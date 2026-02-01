import { useState } from "react";
import type { FallbackProps } from "react-error-boundary";
import { Button } from "@/components/ui/button";

/**
 * Default error fallback for the app-level error boundary.
 * Shows a user-friendly error message with retry option.
 * Stack trace only visible in development.
 */
export function ErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  const [copied, setCopied] = useState(false);
  const componentStack =
    typeof window !== "undefined"
      ? (window as { __APP_LAST_COMPONENT_STACK__?: string }).__APP_LAST_COMPONENT_STACK__
      : undefined;

  async function copyErrorDetails() {
    if (!error) return;
    const details = [
      `Message: ${error.message}`,
      componentStack ? `\nComponent stack:\n${componentStack}` : "",
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
      <div className="bg-card/60 border-border/60 w-full max-w-2xl rounded-2xl border p-6 shadow-sm backdrop-blur">
        <div className="flex items-start gap-4">
          <div className="bg-destructive/10 text-destructive flex h-12 w-12 items-center justify-center rounded-full">
            <span className="text-xl" aria-hidden="true">
              &#x26A0;&#xFE0F;
            </span>
          </div>
          <div className="flex-1">
            <h2 className="text-xl font-semibold">Something went wrong</h2>
            <p className="text-muted-foreground mt-1">
              The application encountered an unexpected error. You can try again or reload.
            </p>
          </div>
        </div>

        {/* Error details - only in development */}
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
              {import.meta.env.DEV && componentStack && (
                <>
                  <strong className="text-foreground mt-4 block">Component stack:</strong>
                  <pre className="text-muted-foreground mt-2 whitespace-pre-wrap">
                    {componentStack}
                  </pre>
                </>
              )}
            </div>
          </details>
        )}

        {/* Action buttons */}
        <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
          <Button onClick={resetErrorBoundary}>Try Again</Button>
          <Button onClick={() => window.location.reload()} variant="outline">
            Reload
          </Button>
        </div>
      </div>
    </div>
  );
}
