import type { FallbackProps } from "react-error-boundary";
import { Button } from "@/components/ui/button";

/**
 * Dashboard-specific error fallback UI.
 * Shown when the Dashboard/MainLayout component crashes.
 * Uses FallbackProps to integrate with react-error-boundary.
 */
export function DashboardError({ resetErrorBoundary }: FallbackProps) {
  return (
    <div className="bg-background text-foreground flex h-screen items-center justify-center p-8">
      <div className="max-w-md text-center">
        <div className="mb-4 text-6xl">&#x1F4CA;</div>
        <h2 className="mb-4 text-2xl font-semibold">Dashboard Error</h2>
        <p className="text-muted-foreground mb-8">
          The dashboard encountered an error while loading your workspaces. This might be a
          temporary issue.
        </p>
        <div className="flex justify-center gap-4">
          <Button onClick={resetErrorBoundary}>Try Again</Button>
          <Button onClick={() => (window.location.href = "/")} variant="outline">
            Reload Dashboard
          </Button>
        </div>
      </div>
    </div>
  );
}
