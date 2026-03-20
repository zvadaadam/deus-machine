import { useState, useEffect } from "react";
import type { FallbackProps } from "react-error-boundary";
import { Button } from "@/components/ui/button";
import { isElectronEnv, invoke } from "@/platform/electron";
import { normalizeError } from "@/shared/utils/errorReporting";

/**
 * Default error fallback for the app-level error boundary.
 * Shows a user-friendly error message with retry option.
 * Stack trace only visible in development.
 *
 * IMPORTANT: The main window starts hidden (show: false in createWindow).
 * If an error occurs before the frontend calls show_main_window or
 * enter_onboarding_mode, the error page renders inside an invisible window.
 * We force-show the window here so the user can actually see the error.
 */
export function ErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  const [copied, setCopied] = useState(false);

  // Force-show the window so the error is visible to the user.
  // Without this, errors during boot leave the window hidden forever.
  useEffect(() => {
    if (isElectronEnv) {
      invoke("show_main_window").catch(console.error);
    }
  }, []);
  const normalizedError = normalizeError(error);
  const componentStack =
    typeof window !== "undefined"
      ? (window as { __APP_LAST_COMPONENT_STACK__?: string }).__APP_LAST_COMPONENT_STACK__
      : undefined;

  async function copyErrorDetails() {
    const details = [
      `Message: ${normalizedError.message}`,
      componentStack ? `\nComponent stack:\n${componentStack}` : "",
      normalizedError.stack ? `\nStack:\n${normalizedError.stack}` : "",
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
        {Boolean(error) && (
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
              <pre className="text-foreground/90 mt-2 whitespace-pre-wrap">
                {normalizedError.message}
              </pre>
              {import.meta.env.DEV && normalizedError.stack && (
                <>
                  <strong className="text-foreground mt-4 block">Stack trace:</strong>
                  <pre className="text-muted-foreground mt-2 whitespace-pre-wrap">
                    {normalizedError.stack}
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
