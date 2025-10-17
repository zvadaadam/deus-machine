import { Component, ErrorInfo, ReactNode } from 'react';

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
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100vh',
            padding: '2rem',
            backgroundColor: 'var(--bg-primary, #ffffff)',
            color: 'var(--text-primary, #111827)',
          }}
        >
          <div style={{ maxWidth: '600px', textAlign: 'center' }}>
            <div style={{ fontSize: '48px', marginBottom: '1rem' }}>⚠️</div>
            <h2 style={{ fontSize: '24px', fontWeight: 600, marginBottom: '1rem' }}>
              Something went wrong
            </h2>
            <p style={{ color: 'var(--text-secondary, #6b7280)', marginBottom: '2rem' }}>
              The application encountered an unexpected error. You can try reloading the page or
              resetting the component.
            </p>

            {/* Error details - collapsible */}
            {this.state.error && (
              <details style={{ marginBottom: '2rem', textAlign: 'left' }}>
                <summary
                  style={{
                    cursor: 'pointer',
                    padding: '0.5rem',
                    backgroundColor: 'var(--bg-secondary, #f9fafb)',
                    borderRadius: '4px',
                    marginBottom: '0.5rem',
                  }}
                >
                  Error details
                </summary>
                <div
                  style={{
                    padding: '1rem',
                    backgroundColor: 'var(--bg-secondary, #f9fafb)',
                    borderRadius: '4px',
                    fontSize: '14px',
                    fontFamily: 'monospace',
                    maxHeight: '200px',
                    overflow: 'auto',
                  }}
                >
                  <strong>Error:</strong>
                  <pre style={{ marginTop: '0.5rem', whiteSpace: 'pre-wrap' }}>
                    {this.state.error.message}
                  </pre>
                  {this.state.error.stack && (
                    <>
                      <strong style={{ marginTop: '1rem', display: 'block' }}>Stack trace:</strong>
                      <pre style={{ marginTop: '0.5rem', whiteSpace: 'pre-wrap', fontSize: '12px' }}>
                        {this.state.error.stack}
                      </pre>
                    </>
                  )}
                </div>
              </details>
            )}

            {/* Action buttons */}
            <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center' }}>
              <button
                onClick={this.handleReset}
                style={{
                  padding: '0.75rem 1.5rem',
                  backgroundColor: 'var(--color-primary-600, #2563eb)',
                  color: 'white',
                  border: 'none',
                  borderRadius: '6px',
                  fontSize: '14px',
                  fontWeight: 500,
                  cursor: 'pointer',
                  transition: 'background-color 0.2s',
                }}
                onMouseOver={(e) => {
                  e.currentTarget.style.backgroundColor = 'var(--color-primary-700, #1d4ed8)';
                }}
                onMouseOut={(e) => {
                  e.currentTarget.style.backgroundColor = 'var(--color-primary-600, #2563eb)';
                }}
              >
                Try Again
              </button>
              <button
                onClick={this.handleReload}
                style={{
                  padding: '0.75rem 1.5rem',
                  backgroundColor: 'transparent',
                  color: 'var(--color-primary-600, #2563eb)',
                  border: '1px solid var(--color-primary-600, #2563eb)',
                  borderRadius: '6px',
                  fontSize: '14px',
                  fontWeight: 500,
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                }}
                onMouseOver={(e) => {
                  e.currentTarget.style.backgroundColor = 'var(--color-primary-50, #eff6ff)';
                }}
                onMouseOut={(e) => {
                  e.currentTarget.style.backgroundColor = 'transparent';
                }}
              >
                Reload Application
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
