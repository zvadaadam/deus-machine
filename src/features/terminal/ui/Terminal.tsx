import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "xterm";
import { FitAddon } from "xterm-addon-fit";
import { WebLinksAddon } from "xterm-addon-web-links";
import { listen } from "@tauri-apps/api/event";
import { ptyCommands } from "@/platform";
import "xterm/css/xterm.css";
import "./Terminal.css";

interface TerminalProps {
  id: string;
  workspacePath: string;
  onClose?: () => void;
}

export function Terminal({ id, workspacePath }: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    if (!terminalRef.current) return;

    // Create xterm instance
    const xterm = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Suisse Intl Mono, Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: "#1e1e1e",
        foreground: "#d4d4d4",
        cursor: "#d4d4d4",
        black: "#000000",
        red: "#cd3131",
        green: "#0dbc79",
        yellow: "#e5e510",
        blue: "#2472c8",
        magenta: "#bc3fbc",
        cyan: "#11a8cd",
        white: "#e5e5e5",
        brightBlack: "#666666",
        brightRed: "#f14c4c",
        brightGreen: "#23d18b",
        brightYellow: "#f5f543",
        brightBlue: "#3b8eea",
        brightMagenta: "#d670d6",
        brightCyan: "#29b8db",
        brightWhite: "#e5e5e5",
      },
      allowProposedApi: true,
    });

    // Add addons
    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.loadAddon(new WebLinksAddon());

    // Open terminal
    xterm.open(terminalRef.current);
    fitAddon.fit();

    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;

    // Check if we're running in Tauri or browser
    const isTauri = "__TAURI__" in window;

    if (!isTauri) {
      // Browser mode - show message that terminal requires Tauri app
      xterm.write("\r\n\x1b[33m═══════════════════════════════════════════════════════\x1b[0m\r\n");
      xterm.write("\r\n  \x1b[33m⚠️  Terminal not available in browser mode\x1b[0m\r\n\r\n");
      xterm.write("  The terminal feature requires the Tauri desktop app.\r\n\r\n");
      xterm.write("  \x1b[36mTo use the terminal:\x1b[0m\r\n");
      xterm.write(
        "  1. Install Rust: \x1b[36mcurl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh\x1b[0m\r\n"
      );
      xterm.write("  2. Build the app: \x1b[36mnpm run tauri:dev\x1b[0m\r\n\r\n");
      xterm.write("\x1b[33m═══════════════════════════════════════════════════════\x1b[0m\r\n");
      return;
    }

    // Spawn PTY (only in Tauri mode)
    const shell = process.platform === "win32" ? "powershell.exe" : "/bin/zsh";
    ptyCommands
      .spawn({
        id,
        command: shell,
        args: [],
        cols: xterm.cols,
        rows: xterm.rows,
        cwd: workspacePath,
      })
      .then(() => {
        setIsReady(true);
      })
      .catch((err) => {
        console.error("Failed to spawn PTY:", err);
        xterm.write(`\r\n\x1b[31mFailed to start terminal: ${err}\x1b[0m\r\n`);
      });

    // Listen for PTY data
    const unlistenData = listen<{ id: string; data: number[] }>("pty-data", (event) => {
      if (event.payload.id === id) {
        const text = new TextDecoder().decode(new Uint8Array(event.payload.data));
        xterm.write(text);
      }
    });

    // Listen for PTY exit
    const unlistenExit = listen<{ id: string }>("pty-exit", (event) => {
      if (event.payload.id === id) {
        xterm.write("\r\n\x1b[33mTerminal session ended\x1b[0m\r\n");
      }
    });

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      if (isReady) {
        ptyCommands.resize(id, xterm.cols, xterm.rows).catch((err) => {
          console.error("Failed to resize PTY:", err);
        });
      }
    });
    resizeObserver.observe(terminalRef.current);

    // Cleanup
    return () => {
      resizeObserver.disconnect();
      unlistenData.then((fn) => fn());
      unlistenExit.then((fn) => fn());
      ptyCommands.kill(id).catch((err) => {
        console.error("Failed to kill PTY:", err);
      });
      xterm.dispose();
    };
  }, [id, workspacePath]);

  // Handle terminal input - tracks isReady changes
  useEffect(() => {
    if (!xtermRef.current) return;

    const disposable = xtermRef.current.onData((data) => {
      if (isReady) {
        const bytes = new TextEncoder().encode(data);
        ptyCommands.write(id, Array.from(bytes)).catch((err) => {
          console.error("Failed to write to PTY:", err);
        });
      }
    });

    return () => disposable.dispose();
  }, [isReady, id]);

  return (
    <div className="terminal-container">
      <div ref={terminalRef} className="terminal" />
    </div>
  );
}
