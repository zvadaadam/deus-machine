import type { FallbackProps } from "react-error-boundary";
import { Button } from "@/components/ui/button";

/**
 * Default error fallback for the app-level error boundary.
 * Shows a user-friendly error message with retry option.
 * Stack trace only visible in development.
 */
export function ErrorFallback({ error, resetErrorBoundary }: FallbackProps) {
  return (
    <div className="bg-background text-foreground flex h-screen flex-col items-center justify-center p-8">
      <div className="max-w-2xl text-center">
        <div className="mb-4 text-5xl">&#x26A0;&#xFE0F;</div>
        <h2 className="mb-4 text-2xl font-semibold">Something went wrong</h2>
        <p className="text-muted-foreground mb-8">
          The application encountered an unexpected error. You can try again or reload the page.
        </p>

        {/* Error details - only in development */}
        {import.meta.env.DEV && error && (
          <details className="mb-8 text-left">
            <summary className="bg-muted mb-2 cursor-pointer rounded p-2 text-sm font-medium">
              Error details (dev only)
            </summary>
            <div className="bg-muted max-h-48 overflow-auto rounded p-4 font-mono text-sm">
              <strong className="text-foreground">Error:</strong>
              <pre className="text-foreground/90 mt-2 whitespace-pre-wrap">{error.message}</pre>
              {error.stack && (
                <>
                  <strong className="text-foreground mt-4 block">Stack trace:</strong>
                  <pre className="text-muted-foreground mt-2 text-xs whitespace-pre-wrap">
                    {error.stack}
                  </pre>
                </>
              )}
            </div>
          </details>
        )}

        {/* Action buttons */}
        <div className="flex justify-center gap-4">
          <Button onClick={resetErrorBoundary}>Try Again</Button>
          <Button onClick={() => window.location.reload()} variant="outline">
            Reload Application
          </Button>
        </div>
      </div>
    </div>
  );
}
