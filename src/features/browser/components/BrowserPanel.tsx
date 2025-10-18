import { useEffect, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Globe, RefreshCw, ArrowLeft, ArrowRight, Loader2 } from "lucide-react";

interface BrowserPanelProps {
  workspaceId: string | null;
}

export function BrowserPanel({ }: BrowserPanelProps) {
  const [url, setUrl] = useState("https://example.com");
  const [currentUrl, setCurrentUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [serverRunning, setServerRunning] = useState(false);
  const [serverPort, setServerPort] = useState<number | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(null);

  // Start dev-browser server when component mounts
  useEffect(() => {
    startBrowserServer();

    return () => {
      // Clean up: stop server when unmounting
      stopBrowserServer();
    };
  }, []);

  async function startBrowserServer() {
    try {
      setLoading(true);
      // Path to dev-browser project
      const devBrowserPath = "/Users/zvada/Documents/BOX/dev-browser";

      await invoke("start_browser_server", { browserPath: devBrowserPath });

      // Wait a bit for server to start
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Get the port and auth token
      const port = await invoke<number>("get_browser_port");
      const token = await invoke<string>("get_browser_auth_token");

      setServerPort(port);
      setAuthToken(token);
      setServerRunning(true);

      console.log("Browser server started on port:", port);
      console.log("Auth token:", token.substring(0, 16) + "...");
    } catch (error) {
      console.error("Failed to start browser server:", error);
      setServerRunning(false);
    } finally {
      setLoading(false);
    }
  }

  async function stopBrowserServer() {
    try {
      await invoke("stop_browser_server");
      setServerRunning(false);
      setServerPort(null);
      setAuthToken(null);
    } catch (error) {
      console.error("Failed to stop browser server:", error);
    }
  }

  async function navigateToUrl() {
    if (!serverRunning || !serverPort || !authToken) {
      console.error("Browser server not running or missing auth token");
      return;
    }

    try {
      setLoading(true);

      // Call dev-browser navigate tool with auth token
      const response = await fetch(`http://localhost:${serverPort}/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-MCP-Auth-Token": authToken,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            name: "browser_navigate",
            arguments: { url },
          },
          id: Date.now(),
        }),
      });

      const data = await response.json();
      console.log("Navigate result:", data);

      if (data.error) {
        console.error("Navigation error:", data.error);
      } else {
        setCurrentUrl(url);
      }
    } catch (error) {
      console.error("Failed to navigate:", error);
    } finally {
      setLoading(false);
    }
  }

  async function reload() {
    if (currentUrl) {
      setUrl(currentUrl);
      await navigateToUrl();
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
          disabled={!serverRunning || loading}
          title="Go back"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          disabled={!serverRunning || loading}
          title="Go forward"
        >
          <ArrowRight className="h-4 w-4" />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={reload}
          disabled={!serverRunning || loading || !currentUrl}
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
            disabled={!serverRunning || loading}
          />
        </div>

        <Button
          size="sm"
          onClick={navigateToUrl}
          disabled={!serverRunning || loading || !url}
          className="h-8"
        >
          {loading && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
          Go
        </Button>
      </div>

      {/* Browser View */}
      <div className="flex-1 relative bg-background">
        {!serverRunning ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <Loader2 className="h-8 w-8 animate-spin mx-auto mb-3 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Starting browser server...</p>
            </div>
          </div>
        ) : currentUrl ? (
          <div className="w-full h-full">
            <div className="absolute inset-0 flex items-center justify-center bg-muted/10">
              <div className="text-center max-w-md p-8">
                <Globe className="h-16 w-16 mx-auto mb-4 text-primary" />
                <h3 className="text-lg font-semibold mb-2">Browser Automation Active</h3>
                <p className="text-sm text-muted-foreground mb-4">
                  The dev-browser Playwright automation is running in a separate window.
                </p>
                <div className="text-xs text-muted-foreground bg-muted p-3 rounded-md font-mono">
                  Current URL: {currentUrl}
                </div>
                <p className="text-xs text-muted-foreground mt-4">
                  The browser window will appear separately on your desktop.
                  You can control it using the tools in this panel.
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="text-center max-w-md p-8">
              <Globe className="h-12 w-12 mx-auto mb-3 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                Enter a URL above and click Go to start browsing
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Server Status */}
      <div className="px-3 py-2 border-t border-border bg-muted/30 text-xs text-muted-foreground flex items-center gap-2">
        <div className={`h-2 w-2 rounded-full ${serverRunning ? "bg-green-500" : "bg-gray-400"}`} />
        {serverRunning ? (
          <span>Browser server running on port {serverPort}</span>
        ) : (
          <span>Browser server offline</span>
        )}
      </div>
    </div>
  );
}
