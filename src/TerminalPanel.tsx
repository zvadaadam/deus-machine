import { useState } from 'react';
import { Terminal } from './Terminal';
import './TerminalPanel.css';

interface DevServer {
  url: string;
  port: number;
  detected: boolean;
}

interface TerminalTab {
  id: string;
  title: string;
}

interface TerminalPanelProps {
  workspacePath: string;
  workspaceName: string;
}

export function TerminalPanel({ workspacePath, workspaceName }: TerminalPanelProps) {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [showRun, setShowRun] = useState(true);
  const [nextTerminalNum, setNextTerminalNum] = useState(1);
  const [showBrowser, setShowBrowser] = useState(false);
  const [browserUrl, setBrowserUrl] = useState<string>('');
  const [detectingServer, setDetectingServer] = useState(false);

  function addTerminal() {
    const id = `terminal-${Date.now()}`;
    const newTab: TerminalTab = {
      id,
      title: `Terminal ${nextTerminalNum}`,
    };
    setTabs([...tabs, newTab]);
    setActiveTabId(id);
    setShowRun(false);
    setNextTerminalNum(nextTerminalNum + 1);
  }

  function closeTab(tabId: string) {
    const newTabs = tabs.filter((t) => t.id !== tabId);
    setTabs(newTabs);

    if (activeTabId === tabId) {
      if (newTabs.length > 0) {
        setActiveTabId(newTabs[newTabs.length - 1].id);
      } else {
        setActiveTabId(null);
        setShowRun(true);
      }
    }
  }

  async function detectDevServer(): Promise<DevServer | null> {
    // Common dev server ports to check
    const commonPorts = [5173, 3000, 8080, 4200, 8000, 5000, 3001];

    for (const port of commonPorts) {
      try {
        await fetch(`http://localhost:${port}`, {
          method: 'HEAD',
          mode: 'no-cors', // Allow checking if server exists without CORS
        });
        // If we get here without error, server is running
        return {
          url: `http://localhost:${port}`,
          port,
          detected: true,
        };
      } catch (error) {
        // Server not found on this port, continue
        continue;
      }
    }

    return null;
  }

  async function handleRunWorkspace() {
    console.log('Run workspace clicked for:', workspaceName);
    setDetectingServer(true);

    try {
      const server = await detectDevServer();

      if (server) {
        console.log(`✅ Detected dev server at ${server.url}`);
        setBrowserUrl(server.url);
        setShowBrowser(true);
        setShowRun(false);
      } else {
        alert(
          `No development server detected!\n\n` +
          `Please start your dev server first:\n` +
          `  • Vite: npm run dev (port 5173)\n` +
          `  • React/Next: npm run dev (port 3000)\n` +
          `  • Angular: ng serve (port 4200)\n\n` +
          `Then click Run again.`
        );
      }
    } catch (error) {
      console.error('Error detecting server:', error);
      alert('Error detecting development server. Please check the console.');
    } finally {
      setDetectingServer(false);
    }
  }

  return (
    <div className="terminal-panel">
      <div className="terminal-tabs-header">
        <div className="terminal-tabs">
          {showRun && tabs.length === 0 && (
            <div className="terminal-tab active">
              <span>Run</span>
            </div>
          )}
          {tabs.map((tab) => (
            <div
              key={tab.id}
              className={`terminal-tab ${activeTabId === tab.id ? 'active' : ''}`}
              onClick={() => {
                setActiveTabId(tab.id);
                setShowRun(false);
              }}
            >
              <span>{tab.title}</span>
              <button
                className="tab-close-button"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(tab.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
          <button className="add-terminal-button" onClick={addTerminal} title="New terminal">
            +
          </button>
        </div>
        <button className="run-button" onClick={handleRunWorkspace} title="Run workspace (⌘R)">
          ▶ Run <span className="keybinding">⌘R</span>
        </button>
      </div>

      <div className="terminal-content">
        {showBrowser ? (
          <div className="browser-view">
            <div className="browser-header">
              <div className="browser-url-bar">
                <span className="browser-url">{browserUrl}</span>
              </div>
              <button
                className="browser-close-button"
                onClick={() => {
                  setShowBrowser(false);
                  setShowRun(true);
                  setBrowserUrl('');
                }}
                title="Close browser"
              >
                ×
              </button>
            </div>
            <iframe
              src={browserUrl}
              className="browser-iframe"
              title="Development Server"
              sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
            />
          </div>
        ) : showRun && tabs.length === 0 ? (
          <div className="run-workspace-view">
            <button
              className="run-workspace-button"
              onClick={handleRunWorkspace}
              disabled={detectingServer}
            >
              <div className="play-icon">▶</div>
              <div className="run-text">
                {detectingServer ? 'Detecting server...' : 'Run workspace'}
              </div>
            </button>
            <div className="run-description">Test your changes here.</div>
          </div>
        ) : (
          tabs.map((tab) => (
            <div
              key={tab.id}
              className="terminal-wrapper"
              style={{ display: activeTabId === tab.id ? 'block' : 'none' }}
            >
              <Terminal id={tab.id} workspacePath={workspacePath} onClose={() => closeTab(tab.id)} />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
