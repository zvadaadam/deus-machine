import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Globe, RefreshCw, ExternalLink, Loader2 } from "lucide-react";

interface BrowserPanelProps {
  workspaceId: string | null;
}

export function BrowserPanel({ workspaceId }: BrowserPanelProps) {
  const [url, setUrl] = useState("https://example.com");
  const [currentUrl, setCurrentUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [webviewCreated, setWebviewCreated] = useState(false);
  const webviewLabel = `browser-${workspaceId || 'main'}`;

  // Clean up webview on unmount
  useEffect(() => {
    return () => {
      if (webviewCreated) {
        invoke("close_browser_webview", { label: webviewLabel }).catch(console.error);
      }
    };
  }, [webviewCreated, webviewLabel]);

  async function navigateToUrl() {
    if (!url) return;

    try {
      setLoading(true);

      // Ensure URL has protocol
      let fullUrl = url;
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        fullUrl = 'https://' + url;
      }

      if (!webviewCreated) {
        // Create webview for the first time
        await invoke("create_browser_webview", {
          label: webviewLabel,
          url: fullUrl,
        });
        setWebviewCreated(true);
      } else {
        // Navigate existing webview
        await invoke("navigate_webview", {
          label: webviewLabel,
          url: fullUrl,
        });
      }

      setCurrentUrl(fullUrl);
    } catch (error) {
      console.error("Failed to navigate:", error);
    } finally {
      setLoading(false);
    }
  }

  async function reload() {
    if (currentUrl && webviewCreated) {
      try {
        setLoading(true);
        await invoke("navigate_webview", {
          label: webviewLabel,
          url: currentUrl,
        });
      } catch (error) {
        console.error("Failed to reload:", error);
      } finally {
        setLoading(false);
      }
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

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Browser Controls */}
      <div className="flex items-center gap-2 p-2 border-b border-border bg-muted/50">
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
          onClick={openInExternalBrowser}
          disabled={!currentUrl}
          title="Open in external browser"
        >
          <ExternalLink className="h-4 w-4" />
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

      {/* Browser View - Shows instruction */}
      <div className="flex-1 relative bg-background overflow-hidden">
        {webviewCreated && currentUrl ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center max-w-md p-8">
              <Globe className="h-16 w-16 mx-auto mb-4 text-primary" />
              <h3 className="text-lg font-semibold mb-2">Browser Window Active</h3>
              <p className="text-sm text-muted-foreground mb-4">
                The browser is open in a separate window. You can resize, move, or minimize it.
              </p>
              <div className="text-xs text-muted-foreground bg-muted p-3 rounded-md font-mono break-all">
                Current URL: {currentUrl}
              </div>
              <p className="text-xs text-muted-foreground mt-4">
                Use the controls above to navigate to different pages.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="text-center max-w-md p-8">
              <Globe className="h-12 w-12 mx-auto mb-3 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                Enter a URL above and click Go to open the browser
              </p>
              <p className="text-xs text-muted-foreground mt-2">
                A native browser window will open that you can control from here
              </p>
            </div>
          </div>
        )}

        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/50 backdrop-blur-sm">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        )}
      </div>

      {/* Status Bar */}
      <div className="px-3 py-2 border-t border-border bg-muted/30 text-xs text-muted-foreground flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={`h-2 w-2 rounded-full ${webviewCreated ? "bg-green-500" : "bg-gray-400"}`} />
          <span className="truncate max-w-[400px]">
            {webviewCreated ? (currentUrl || "Browser ready") : "Browser not started"}
          </span>
        </div>
        {webviewCreated && (
          <span className="text-muted-foreground/60">Native WebView</span>
        )}
      </div>
    </div>
  );
}
