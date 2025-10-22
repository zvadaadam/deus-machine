import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Globe, RefreshCw, ExternalLink, Loader2, AlertCircle, Zap, ChevronLeft, ChevronRight, ChevronDown, Terminal, X, Info, Target } from "lucide-react";
import { useBrowser } from "../hooks/useBrowser";

/**
 * Timeout for fetching injection script from dev-browser server
 * Longer than health check timeouts because script generation may take time
 */
const SCRIPT_FETCH_TIMEOUT_MS = 10000;

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
  const [isCrossOrigin, setIsCrossOrigin] = useState(false);
  const [selectorActive, setSelectorActive] = useState(false);

  // Navigation history
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  // Console panel
  const [showConsole, setShowConsole] = useState(false);
  const [consoleLogs, setConsoleLogs] = useState<ConsoleLog[]>([]);
  const consoleEndRef = useRef<HTMLDivElement>(null);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const { status: devBrowserStatus, startServer } = useBrowser();
  const tabId = `browser-${workspaceId || 'main'}`;

  // Helper to add console log
  const MAX_LOGS = 500;
  const addLog = (level: ConsoleLog['level'], message: string) => {
    setConsoleLogs(prev => {
      const next = [...prev, { timestamp: new Date(), level, message }];
      return next.length > MAX_LOGS ? next.slice(next.length - MAX_LOGS) : next;
    });
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

    const iframe = iframeRef.current;

    // Check if we can access iframe content (same-origin check)
    try {
      // Try to access contentDocument - will throw if cross-origin
      const canAccess = iframe.contentDocument !== null;
      if (!canAccess) {
        throw new Error('Cross-origin iframe - cannot access content');
      }
    } catch (crossOriginError) {
      // Cross-origin page detected - browsing works but automation doesn't
      setIsCrossOrigin(true);
      setInjected(false);
      addLog('info', '🌐 Browsing external website (automation unavailable)');
      addLog('info', 'ℹ️  Automation only works with: file://, localhost, or same-origin pages');
      return;
    }

    // Same-origin page - automation available
    setIsCrossOrigin(false);

    try {
      addLog('info', `Fetching injection script from MCP server (port ${devBrowserStatus.port})...`);

      // Get parent origin for postMessage security
      const parentOrigin = window.location.origin; // e.g., http://localhost:1420

      // Get injection script from dev-browser
      const injectionUrl = `http://localhost:${devBrowserStatus.port}/inject-script?tabId=${encodeURIComponent(tabId)}&parentOrigin=${encodeURIComponent(parentOrigin)}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), SCRIPT_FETCH_TIMEOUT_MS);
      const response = await fetch(injectionUrl, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Failed to fetch script: ${response.status}`);
      }

      const scriptContent = await response.text();

      addLog('debug', `Script fetched (${scriptContent.length} chars), injecting into iframe...`);

      // Inject into iframe
      if (iframe.contentDocument && iframe.contentDocument.body) {
        // Create script element in iframe
        const script = iframe.contentDocument.createElement('script');
        script.textContent = scriptContent;
        iframe.contentDocument.body.appendChild(script);
        setInjected(true);
        addLog('info', '✓ Automation script injected successfully');

        // Check if automation registered after a delay
        setTimeout(() => {
          try {
            // Avoid eval; directly probe the flag placed by the injected script
            const automationReady = Boolean((iframe.contentWindow as any)?.__browserAutomation);
            if (automationReady) {
              addLog('info', '✓ Browser automation registered and ready');
            } else {
              addLog('warn', 'Automation script injected but not yet registered');
            }
          } catch (e) {
            addLog('warn', 'Cannot verify automation status');
          }
        }, 1000);
      } else {
        throw new Error('Iframe document or body not available');
      }
    } catch (err) {
      console.error("Failed to inject automation:", err);
      const errorMsg = err instanceof Error ? err.message : "Injection failed";
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
      window.open(currentUrl, '_blank', 'noopener,noreferrer');
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

  // ==================== ELEMENT SELECTOR FUNCTIONS ====================

  /**
   * Toggle element selector mode on/off
   * Sends postMessage to iframe to activate/deactivate visual selection
   */
  function toggleElementSelector() {
    if (!iframeRef.current || !injected || !currentUrl) return;

    // Get target origin for secure postMessage
    let targetOrigin: string;
    try {
      targetOrigin = new URL(currentUrl).origin;
    } catch {
      addLog('warn', 'Invalid URL origin; cannot toggle element selector securely');
      return;
    }

    if (selectorActive) {
      // Disable selector mode
      addLog('info', '🎯 Deactivating element selector');
      iframeRef.current.contentWindow?.postMessage({
        type: 'disable-element-selection'
      }, targetOrigin);
      setSelectorActive(false);
    } else {
      // Enable selector mode
      addLog('info', '🎯 Activating element selector - Click any element to inspect');
      iframeRef.current.contentWindow?.postMessage({
        type: 'enable-element-selection'
      }, targetOrigin);
      setSelectorActive(true);
    }
  }

  /**
   * Handle element selected from iframe
   * Formats element data and dispatches to chat
   */
  function handleElementSelected(elementData: any) {
    const tn = elementData?.element?.tagName?.toLowerCase?.() ?? 'element';
    const eid = elementData?.element?.id ? `#${elementData.element.id}` : '';
    addLog('info', `✓ Element selected: ${tn}${eid}`);

    const formatted = formatElementForChat(elementData);

    // Dispatch custom event for Dashboard to pick up
    window.dispatchEvent(new CustomEvent('insert-to-chat', {
      detail: { text: formatted }
    }));

    setSelectorActive(false);
    // Best-effort: ensure selector is turned off in iframe as well
    try {
      const frame = iframeRef.current?.contentWindow;
      if (frame && currentUrl) {
        const to = new URL(currentUrl).origin;
        frame.postMessage({ type: 'disable-element-selection' }, to);
      }
    } catch {}
    addLog('info', '📝 Element data sent to chat');
  }

  /**
   * Format element data as markdown for chat insertion
   * Defensive guards protect against malformed postMessage data
   */
  function formatElementForChat(elementData: any): string {
    // Defensive guards for untrusted postMessage data
    const el = elementData?.element || {};
    const tagName = (el.tagName || 'element').toLowerCase?.() || 'element';
    const idText = el.id ? `#${el.id}` : '';
    const classText = typeof el.className === 'string' && el.className
      ? '.' + el.className.split(' ').filter(Boolean).join('.')
      : '';
    const elementSelector = tagName + idText + classText;

    // Build React component section if available
    const rc = elementData?.reactComponent;
    let reactSection = '';
    if (rc && (rc.name || rc.fileName)) {
      const lines = ['### ⚛️ React Component'];
      if (rc.name) lines.push(`- **Component:** \`${rc.name}\``);
      if (rc.fileName) {
        const fileInfo = rc.lineNumber != null ? `${rc.fileName}:${rc.lineNumber}` : rc.fileName;
        lines.push(`- **File:** \`${fileInfo}\``);
      }
      reactSection = '\n' + lines.join('\n') + '\n';
    }

    // Safe rect access
    const rect = el.rect || { left: 0, top: 0, width: 0, height: 0 };
    const position = `(${Math.round(rect.left)}, ${Math.round(rect.top)})`;
    const size = `${Math.round(rect.width)}×${Math.round(rect.height)}`;

    // Safe text access
    const textContent = typeof el.innerText === 'string' && el.innerText
      ? `**Text:** "${el.innerText.substring(0, 100)}${el.innerText.length > 100 ? '...' : ''}"`
      : '';

    // Safe attributes
    const attributes = Array.isArray(el.attributes) && el.attributes.length > 0
      ? el.attributes.map((a: any) => `- **${a?.name ?? 'unknown'}**: \`"${a?.value ?? ''}"\``).join('\n')
      : '_(No attributes)_';

    // Safe computed styles
    const styles = el.computedStyle || {};

    return `
## 🎯 Selected Element

**Element:** \`${elementSelector}\`
**Path:** ${el.path ?? '_(unknown)_'}
**Position:** ${position}
**Size:** ${size}
${textContent}
${reactSection}
### Attributes
${attributes}

### Computed Styles
- **color**: ${styles.color ?? '_'}
- **backgroundColor**: ${styles.backgroundColor ?? '_'}
- **fontSize**: ${styles.fontSize ?? '_'}
- **fontWeight**: ${styles.fontWeight ?? '_'}
- **display**: ${styles.display ?? '_'}
- **position**: ${styles.position ?? '_'}

---
_You can ask me to modify this element, debug it, or help with related styling._
`.trim();
  }

  // Listen for postMessage from iframe (element selection results)
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Security: Validate message source, origin, and state
      const frame = iframeRef.current?.contentWindow;
      if (event.source !== frame) return;

      // Validate origin matches iframe URL
      try {
        const expectedOrigin = currentUrl ? new URL(currentUrl).origin : null;
        if (!expectedOrigin || event.origin !== expectedOrigin) return;
      } catch {
        return; // Invalid URL
      }

      // Only accept messages when selector is active and automation is injected
      if (!selectorActive || !injected) return;

      // Validate message data structure
      if (!event.data || typeof event.data !== 'object') return;

      if (event.data.type === 'element-selected') {
        handleElementSelected(event.data);
      } else if (event.data.type === 'exit-selection-mode') {
        setSelectorActive(false);
        addLog('info', 'Element selector deactivated (Escape pressed)');
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [injected, iframeRef, selectorActive, currentUrl]);

  // ==================== END ELEMENT SELECTOR FUNCTIONS ====================

  return (
    <div className="w-full flex flex-col h-full overflow-hidden">
      {/* Browser Controls */}
      <div className="flex items-center gap-2 p-2 border-b border-border/40 flex-shrink-0">
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
          <Zap className={`h-4 w-4 ${injected ? "text-success" : ""}`} />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={toggleElementSelector}
          disabled={!currentUrl || !injected || isCrossOrigin}
          aria-pressed={selectorActive}
          title={selectorActive ? "Exit element selector (Esc)" : "Select element to inspect"}
        >
          <Target className={`h-4 w-4 ${selectorActive ? "text-primary animate-pulse" : ""}`} />
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
          onClick={() => navigateToUrl()}
          disabled={loading || !url}
          className="h-8"
        >
          {loading && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
          Go
        </Button>
      </div>

      {/* Browser View - Sandboxed iframe like Cursor */}
      <div className={`relative overflow-hidden ${showConsole ? 'flex-1' : 'flex-1 min-h-0'}`}>
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

            {/* Cross-Origin Info Banner */}
            {isCrossOrigin && !loading && (
              <div className="absolute top-0 left-0 right-0 bg-warning/10 border-b border-warning/20 backdrop-blur-sm">
                <div className="flex items-center gap-2 px-3 py-2">
                  <Info className="h-3.5 w-3.5 text-warning flex-shrink-0" />
                  <p className="text-xs text-warning-foreground flex-1">
                    <span className="font-medium">Browsing only</span> — AI automation unavailable on external websites
                  </p>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5 hover:bg-warning/20"
                    onClick={() => setIsCrossOrigin(false)}
                    title="Dismiss"
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            )}

            {/* Error overlay */}
            {error && (
              <div className="absolute inset-0 flex items-center justify-center vibrancy-bg">
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
              <p className="text-sm text-muted-foreground mb-4">
                Enter a URL above and click Go to browse
              </p>
              <div className="bg-info/10 border border-info/20 rounded-lg p-3 text-left">
                <div className="flex items-start gap-2">
                  <Info className="h-4 w-4 text-info mt-0.5 flex-shrink-0" />
                  <div className="text-xs text-muted-foreground space-y-1">
                    <p className="font-medium text-foreground">AI automation works with:</p>
                    <ul className="space-y-0.5 ml-2">
                      <li>• Local files (file:// URLs)</li>
                      <li>• Localhost pages</li>
                      <li>• Same-origin content</li>
                    </ul>
                    <p className="mt-2 text-warning">
                      External websites (https://) block automation due to browser security.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Loading overlay */}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center vibrancy-bg">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        )}
      </div>

      {/* Status Bar */}
      <div className="px-3 py-2 border-t border-border bg-muted/30 text-xs text-muted-foreground flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <div className={`h-2 w-2 rounded-full ${currentUrl ? "bg-success" : "bg-muted-foreground/40"}`} />
            <span className="truncate max-w-[300px]">
              {currentUrl || "No page loaded"}
            </span>
          </div>
          {devBrowserStatus.running && currentUrl && (
            <div className="flex items-center gap-1.5">
              <Zap className={`h-3 w-3 ${
                injected ? "text-success" :
                isCrossOrigin ? "text-warning" :
                "text-muted-foreground/60"
              }`} />
              <span className={
                injected ? "text-success" :
                isCrossOrigin ? "text-warning" :
                "text-muted-foreground/60"
              }>
                {injected ? "AI-ready" : isCrossOrigin ? "Browse-only" : "Manual"}
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
        <div className="h-[200px] border-t border-border bg-muted/10 flex flex-col flex-shrink-0">
          {/* Console Header */}
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-muted/30 flex-shrink-0">
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
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => setShowConsole(false)}
                title="Close console"
              >
                <ChevronDown className="h-3 w-3" />
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
                    log.level === 'error' ? 'text-destructive' :
                    log.level === 'warn' ? 'text-warning' :
                    log.level === 'debug' ? 'text-info' :
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
