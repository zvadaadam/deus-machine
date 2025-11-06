import { Component, ErrorInfo, ReactNode } from 'react';
import { Button } from '@/components/ui/button';

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
    console.error('[ErrorBoundary] Caught error:', error);
    console.error('[ErrorBoundary] Error info:', errorInfo);

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
        <div className="flex flex-col items-center justify-center h-screen p-8 bg-background text-foreground">
          <div className="max-w-2xl text-center">
            <div className="text-5xl mb-4">⚠️</div>
            <h2 className="text-2xl font-semibold mb-4">
              Something went wrong
            </h2>
            <p className="text-muted-foreground mb-8">
              The application encountered an unexpected error. You can try reloading the page or
              resetting the component.
            </p>

            {/* Error details - collapsible */}
            {this.state.error && (
              <details className="mb-8 text-left">
                <summary className="cursor-pointer p-2 bg-muted rounded mb-2 text-sm font-medium">
                  Error details
                </summary>
                <div className="p-4 bg-muted rounded text-sm font-mono max-h-50 overflow-auto">
                  <strong className="text-foreground">Error:</strong>
                  <pre className="mt-2 whitespace-pre-wrap text-foreground/90">
                    {this.state.error.message}
                  </pre>
                  {this.state.error.stack && (
                    <>
                      <strong className="mt-4 block text-foreground">Stack trace:</strong>
                      <pre className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">
                        {this.state.error.stack}
                      </pre>
                    </>
                  )}
                </div>
              </details>
            )}

            {/* Action buttons */}
            <div className="flex gap-4 justify-center">
              <Button onClick={this.handleReset}>
                Try Again
              </Button>
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
