import { Component, ErrorInfo, ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface State {
  hasError: boolean;
  error?: Error;
  errorInfo?: ErrorInfo;
}

/**
 * Error Boundary Component
 * Catches JavaScript errors anywhere in the child component tree
 * and displays a fallback UI instead of crashing the entire app
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    // Update state so the next render will show the fallback UI
    return {
      hasError: true,
      error,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    // Log error to console
    console.error("[ErrorBoundary] Caught error:", error);
    console.error("[ErrorBoundary] Error info:", errorInfo);

    // Update state with error info
    this.setState({
      errorInfo,
    });

    // Call optional error handler prop
    this.props.onError?.(error, errorInfo);

    // TODO: Send error to error tracking service (Sentry, etc.)
    // trackError(error, { componentStack: errorInfo.componentStack });
  }

  handleReset = () => {
    this.setState({ hasError: false, error: undefined, errorInfo: undefined });
  };

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      // Custom fallback UI provided
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // Default fallback UI
      return (
        <div className="bg-background text-foreground flex h-screen flex-col items-center justify-center p-8">
          <div className="max-w-2xl text-center">
            <div className="mb-4 text-5xl">⚠️</div>
            <h2 className="mb-4 text-2xl font-semibold">Something went wrong</h2>
            <p className="text-muted-foreground mb-8">
              The application encountered an unexpected error. You can try reloading the page or
              resetting the component.
            </p>

            {/* Error details - collapsible */}
            {this.state.error && (
              <details className="mb-8 text-left">
                <summary className="bg-muted mb-2 cursor-pointer rounded p-2 text-sm font-medium">
                  Error details
                </summary>
                <div className="bg-muted max-h-50 overflow-auto rounded p-4 font-mono text-sm">
                  <strong className="text-foreground">Error:</strong>
                  <pre className="text-foreground/90 mt-2 whitespace-pre-wrap">
                    {this.state.error.message}
                  </pre>
                  {this.state.error.stack && (
                    <>
                      <strong className="text-foreground mt-4 block">Stack trace:</strong>
                      <pre className="text-muted-foreground mt-2 text-xs whitespace-pre-wrap">
                        {this.state.error.stack}
                      </pre>
                    </>
                  )}
                </div>
              </details>
            )}

            {/* Action buttons */}
            <div className="flex justify-center gap-4">
              <Button onClick={this.handleReset}>Try Again</Button>
              <Button onClick={this.handleReload} variant="outline">
                Reload Application
              </Button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
