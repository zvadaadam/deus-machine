import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Globe, RefreshCw, ExternalLink, Loader2, AlertCircle, Zap, ChevronLeft, ChevronRight, Terminal, X } from "lucide-react";
import { useDevBrowser } from "../hooks/useDevBrowser";

interface BrowserPanelProps {
  workspaceId: string | null;
}

interface ConsoleLog {
  timestamp: Date;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
}

export function BrowserPanel({ workspaceId }: BrowserPanelProps) {
  const [url, setUrl] = useState("https://example.com");
  const [currentUrl, setCurrentUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [injected, setInjected] = useState(false);

  // Navigation history
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  // Console panel
  const [showConsole, setShowConsole] = useState(false);
  const [consoleLogs, setConsoleLogs] = useState<ConsoleLog[]>([]);
  const consoleEndRef = useRef<HTMLDivElement>(null);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const { status: devBrowserStatus, startServer } = useDevBrowser();
  const tabId = `browser-${workspaceId || 'main'}`;

  // Helper to add console log
  const addLog = (level: ConsoleLog['level'], message: string) => {
    setConsoleLogs(prev => [...prev, { timestamp: new Date(), level, message }]);
  };

  // Auto-scroll console to bottom
  useEffect(() => {
    if (showConsole && consoleEndRef.current) {
      consoleEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [consoleLogs, showConsole]);

  // Auto-start dev-browser server on mount
  useEffect(() => {
    if (!devBrowserStatus.running && !devBrowserStatus.error) {
      addLog('info', 'Starting dev-browser MCP server...');
      startServer().catch(err => {
        console.error("Failed to auto-start dev-browser:", err);
        addLog('error', `Failed to start MCP server: ${err.message}`);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devBrowserStatus.running, devBrowserStatus.error, startServer]);

  // Log when MCP server starts
  useEffect(() => {
    if (devBrowserStatus.running && devBrowserStatus.port) {
      addLog('info', `MCP server running on port ${devBrowserStatus.port}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devBrowserStatus.running]);

  async function navigateToUrl(urlToNavigate?: string) {
    const targetUrl = urlToNavigate || url;
    if (!targetUrl) return;

    try {
      setLoading(true);
      setError(null);
      setInjected(false);

      // Ensure URL has protocol
      let fullUrl = targetUrl;
      if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://') && !targetUrl.startsWith('file://')) {
        fullUrl = 'https://' + targetUrl;
      }

      addLog('info', `Navigating to: ${fullUrl}`);

      // Update iframe src
      if (iframeRef.current) {
        iframeRef.current.src = fullUrl;
      }

      setCurrentUrl(fullUrl);
      setUrl(fullUrl);

      // Add to history (only if not navigating via back/forward)
      if (!urlToNavigate) {
        setHistory(prev => {
          const newHistory = prev.slice(0, historyIndex + 1);
          newHistory.push(fullUrl);
          return newHistory;
        });
        setHistoryIndex(prev => prev + 1);
      }
    } catch (err) {
      console.error("Failed to navigate:", err);
      const errorMsg = err instanceof Error ? err.message : "Navigation failed";
      setError(errorMsg);
      addLog('error', `Navigation failed: ${errorMsg}`);
    }
  }

  function goBack() {
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1;
      const previousUrl = history[newIndex];
      setHistoryIndex(newIndex);
      setUrl(previousUrl);
      setCurrentUrl(previousUrl);
      setInjected(false);

      if (iframeRef.current) {
        iframeRef.current.src = previousUrl;
      }
    }
  }

  function goForward() {
    if (historyIndex < history.length - 1) {
      const newIndex = historyIndex + 1;
      const nextUrl = history[newIndex];
      setHistoryIndex(newIndex);
      setUrl(nextUrl);
      setCurrentUrl(nextUrl);
      setInjected(false);

      if (iframeRef.current) {
        iframeRef.current.src = nextUrl;
      }
    }
  }

  async function injectAutomation() {
    if (!devBrowserStatus.running || !devBrowserStatus.port || !iframeRef.current) {
      const errorMsg = "Dev-browser server not running";
      setError(errorMsg);
      addLog('error', errorMsg);
      return;
    }

    try {
      addLog('info', `Fetching injection script from MCP server (port ${devBrowserStatus.port})...`);

      // Get injection script from dev-browser
      const injectionUrl = `http://localhost:${devBrowserStatus.port}/inject-script?tabId=${encodeURIComponent(tabId)}`;
      const response = await fetch(injectionUrl);
      const scriptContent = await response.text();

      addLog('debug', `Script fetched (${scriptContent.length} chars), injecting into iframe...`);

      // Inject into iframe
      const iframe = iframeRef.current;
      const iframeWindow = iframe.contentWindow;

      if (iframeWindow) {
        // Create script element in iframe
        const script = iframe.contentDocument?.createElement('script');
        if (script) {
          script.textContent = scriptContent;
          iframe.contentDocument?.body.appendChild(script);
          setInjected(true);
          addLog('info', '✓ Automation script injected successfully');

          // Check if automation registered after a delay
          setTimeout(() => {
            try {
              const automationReady = iframe.contentWindow?.eval('window.__browserAutomation !== undefined');
              if (automationReady) {
                addLog('info', '✓ Browser automation registered and ready');
              } else {
                addLog('warn', 'Automation script injected but not yet registered');
              }
            } catch (e) {
              addLog('warn', 'Cannot verify automation status (cross-origin restriction)');
            }
          }, 1000);
        }
      }
    } catch (err) {
      console.error("Failed to inject automation:", err);
      const errorMsg = err instanceof Error ? err.message : "Injection failed";
      setError(errorMsg);
      addLog('error', `Injection failed: ${errorMsg}`);
    }
  }

  function reload() {
    if (iframeRef.current && currentUrl) {
      setLoading(true);
      setError(null);
      setInjected(false);
      iframeRef.current.src = currentUrl;
    }
  }

  function openInExternalBrowser() {
    if (currentUrl) {
      window.open(currentUrl, '_blank');
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      navigateToUrl();
    }
  }

  function handleIframeLoad() {
    setLoading(false);
    setError(null);
    addLog('info', `Page loaded: ${currentUrl}`);

    // Auto-inject automation script after page loads
    if (devBrowserStatus.running && currentUrl && !injected) {
      addLog('info', 'Waiting 500ms before injecting automation...');
      // Delay injection to allow page to fully initialize
      setTimeout(() => {
        injectAutomation();
      }, 500);
    }
  }

  function handleIframeError() {
    setLoading(false);
    const errorMsg = "Failed to load page. The site may block embedding or have CORS restrictions.";
    setError(errorMsg);
    addLog('error', errorMsg);
  }

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Browser Controls */}
      <div className="flex items-center gap-2 p-2 border-b border-border bg-muted/50">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={goBack}
          disabled={loading || historyIndex <= 0}
          title="Go back"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={goForward}
          disabled={loading || historyIndex >= history.length - 1}
          title="Go forward"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={reload}
          disabled={loading || !currentUrl}
          title="Reload"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>

        <div className="flex-1 flex items-center gap-2">
          <Globe className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          <Input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Enter URL..."
            className="h-8 text-sm"
            disabled={loading}
          />
        </div>

        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={injectAutomation}
          disabled={!currentUrl || !devBrowserStatus.running || injected}
          title={injected ? "Automation active" : "Inject automation"}
        >
          <Zap className={`h-4 w-4 ${injected ? "text-green-500" : ""}`} />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={openInExternalBrowser}
          disabled={!currentUrl}
          title="Open in external browser"
        >
          <ExternalLink className="h-4 w-4" />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => setShowConsole(!showConsole)}
          title={showConsole ? "Hide console" : "Show console"}
        >
          <Terminal className={`h-4 w-4 ${showConsole ? "text-primary" : ""}`} />
        </Button>

        <Button
          size="sm"
          onClick={navigateToUrl}
          disabled={loading || !url}
          className="h-8"
        >
          {loading && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
          Go
        </Button>
      </div>

      {/* Browser View - Sandboxed iframe like Cursor */}
      <div className="flex-1 relative bg-background overflow-hidden">
        {currentUrl ? (
          <>
            {/* Sandboxed iframe with Cursor-like permissions */}
            <iframe
              ref={iframeRef}
              src={currentUrl}
              sandbox="allow-scripts allow-forms allow-same-origin allow-downloads allow-pointer-lock allow-popups allow-modals"
              className="w-full h-full border-0"
              onLoad={handleIframeLoad}
              onError={handleIframeError}
              title="Browser"
            />

            {/* Error overlay */}
            {error && (
              <div className="absolute inset-0 flex items-center justify-center bg-background/95">
                <div className="text-center max-w-md p-8">
                  <AlertCircle className="h-12 w-12 mx-auto mb-4 text-destructive" />
                  <h3 className="text-lg font-semibold mb-2">Unable to Load Page</h3>
                  <p className="text-sm text-muted-foreground mb-4">{error}</p>
                  <div className="flex gap-2 justify-center">
                    <Button size="sm" onClick={reload} variant="outline">
                      Try Again
                    </Button>
                    <Button size="sm" onClick={openInExternalBrowser}>
                      Open Externally
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="text-center max-w-md p-8">
              <Globe className="h-12 w-12 mx-auto mb-3 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                Enter a URL above and click Go to browse
              </p>
              <p className="text-xs text-muted-foreground mt-2">
                Web content will be displayed in a sandboxed iframe with AI automation
              </p>
            </div>
          </div>
        )}

        {/* Loading overlay */}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/50 backdrop-blur-sm">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        )}
      </div>

      {/* Status Bar */}
      <div className="px-3 py-2 border-t border-border bg-muted/30 text-xs text-muted-foreground flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <div className={`h-2 w-2 rounded-full ${currentUrl ? "bg-green-500" : "bg-gray-400"}`} />
            <span className="truncate max-w-[300px]">
              {currentUrl || "No page loaded"}
            </span>
          </div>
          {devBrowserStatus.running && (
            <div className="flex items-center gap-1.5">
              <Zap className={`h-3 w-3 ${injected ? "text-green-500" : "text-muted-foreground/60"}`} />
              <span className={injected ? "text-green-500" : "text-muted-foreground/60"}>
                {injected ? "AI-ready" : "Manual"}
              </span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {devBrowserStatus.running && devBrowserStatus.port && (
            <span className="text-muted-foreground/60">
              MCP:{devBrowserStatus.port}
            </span>
          )}
          {currentUrl && (
            <span className="text-muted-foreground/60">Sandboxed iframe</span>
          )}
        </div>
      </div>

      {/* Console Panel */}
      {showConsole && (
        <div className="h-48 border-t border-border bg-muted/10 flex flex-col">
          {/* Console Header */}
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-muted/30">
            <div className="flex items-center gap-2">
              <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs font-medium text-muted-foreground">Console</span>
              <span className="text-xs text-muted-foreground/60">({consoleLogs.length})</span>
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => setConsoleLogs([])}
                title="Clear console"
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          </div>

          {/* Console Content */}
          <div className="flex-1 overflow-y-auto px-3 py-2 font-mono text-xs">
            {consoleLogs.length === 0 ? (
              <div className="text-muted-foreground/50 italic">Console is empty</div>
            ) : (
              <div className="space-y-0.5">
                {consoleLogs.map((log, i) => (
                  <div key={i} className={`flex gap-2 ${
                    log.level === 'error' ? 'text-red-500' :
                    log.level === 'warn' ? 'text-yellow-500' :
                    log.level === 'debug' ? 'text-blue-400' :
                    'text-foreground'
                  }`}>
                    <span className="text-muted-foreground/60 flex-shrink-0">
                      {log.timestamp.toLocaleTimeString('en-US', { hour12: false })}
                    </span>
                    <span className="flex-shrink-0 font-semibold w-14">
                      [{log.level.toUpperCase()}]
                    </span>
                    <span className="flex-1">{log.message}</span>
                  </div>
                ))}
                <div ref={consoleEndRef} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
