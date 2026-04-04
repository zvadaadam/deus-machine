import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { ptyCommands } from "@/platform";
import { onEvent } from "@/platform/ws/query-protocol-client";
import "@xterm/xterm/css/xterm.css";
import "./Terminal.css";

interface TerminalProps {
  id: string;
  workspacePath: string;
  /** Command to execute automatically after shell init (e.g. task execution, "claude login") */
  initialCommand?: string;
  /** Whether this terminal is visible (active tab AND panel visible). Used to refit on visibility change. */
  visible?: boolean;
}

// ANSI color palettes tuned for light and dark backgrounds
const lightTheme = {
  background: "", // filled from CSS var at runtime
  foreground: "", // filled from CSS var at runtime
  cursor: "#4a4e58",
  black: "#3c3f4a",
  red: "#c4302b",
  green: "#168730",
  yellow: "#9d7a00",
  blue: "#1a6fb5",
  magenta: "#a43faa",
  cyan: "#0e8a8a",
  white: "#f0f0f2",
  brightBlack: "#6e7180",
  brightRed: "#e05252",
  brightGreen: "#1fa83e",
  brightYellow: "#b89500",
  brightBlue: "#2b8bd6",
  brightMagenta: "#c05ec7",
  brightCyan: "#12a5a5",
  brightWhite: "#fafafa",
};

const darkTheme = {
  background: "",
  foreground: "",
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
};

/** Convert any CSS color (including oklch) to hex via the Canvas API */
function cssToHex(color: string): string | null {
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = color;
    return ctx.fillStyle; // always returns #rrggbb
  } catch {
    return null;
  }
}

/** Read the app's current theme CSS variables and build an xterm theme object */
function getTerminalTheme() {
  const styles = getComputedStyle(document.documentElement);
  const isDark = document.documentElement.classList.contains("dark");
  const base = isDark ? { ...darkTheme } : { ...lightTheme };

  // Pull bg/fg from the design system so the terminal blends with the app
  const mutedRaw = styles.getPropertyValue("--muted").trim();
  const fgRaw = styles.getPropertyValue("--foreground").trim();
  base.background = (mutedRaw && cssToHex(mutedRaw)) || (isDark ? "#2a2c35" : "#ecedf0");
  base.foreground = (fgRaw && cssToHex(fgRaw)) || (isDark ? "#d4d4d4" : "#2a2c35");

  return base;
}

/** Safely call fitAddon.fit() — xterm's internal render service may not be
 *  fully initialized during rapid mount/unmount cycles, causing a
 *  "Cannot read properties of undefined (reading 'dimensions')" error. */
function safeFit(fitAddon: FitAddon): void {
  try {
    fitAddon.fit();
  } catch {
    // fit() will succeed on the next resize or visibility change
  }
}

export function Terminal({ id, workspacePath, initialCommand, visible = true }: TerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!terminalRef.current) return;

    // Unique PTY id per effect invocation so StrictMode double-fire doesn't collide
    const ptyId = `${id}-${Date.now()}`;
    let disposed = false;
    let ready = false;

    // Create xterm instance with theme-aware colors
    const xterm = new XTerm({
      cursorBlink: true,
      fontSize: 11,
      fontFamily:
        getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() ||
        'ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      letterSpacing: 0,
      theme: getTerminalTheme(),
      allowProposedApi: true,
    });

    // Add addons
    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.loadAddon(new WebLinksAddon());

    // Open terminal
    xterm.open(terminalRef.current);
    safeFit(fitAddon);

    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;

    // Forward terminal input to PTY
    const inputDisposable = xterm.onData((data) => {
      if (ready && !disposed) {
        ptyCommands.write(ptyId, Array.from(new TextEncoder().encode(data))).catch((err) => {
          console.error("Failed to write to PTY:", err);
        });
      }
    });

    // Spawn PTY
    const shell = navigator.platform?.startsWith("Win") ? "powershell.exe" : "/bin/zsh";
    ptyCommands
      .spawn({
        id: ptyId,
        command: shell,
        args: [],
        cols: xterm.cols,
        rows: xterm.rows,
        cwd: workspacePath,
      })
      .then(() => {
        if (!disposed) {
          ready = true;
          // Auto-run initial command after shell init settles
          if (initialCommand) {
            setTimeout(() => {
              if (!disposed) {
                const encoded = Array.from(new TextEncoder().encode(initialCommand + "\n"));
                ptyCommands.write(ptyId, encoded).catch((err) => {
                  console.error("Failed to write initial command:", err);
                });
              }
            }, 300);
          }
        }
      })
      .catch((err) => {
        if (!disposed) {
          console.error("Failed to spawn PTY:", err);
          xterm.write(`\r\n\x1b[31mFailed to start terminal: ${err}\x1b[0m\r\n`);
        }
      });

    // Listen for PTY data via WS q:event
    const unlistenData = onEvent((event, data) => {
      if (disposed) return;
      if (event === "pty-data") {
        const payload = data as { id: string; data: number[] };
        if (payload.id === ptyId) {
          xterm.write(new TextDecoder().decode(new Uint8Array(payload.data)));
        }
      }
    });

    // Listen for PTY exit via WS q:event
    const unlistenExit = onEvent((event, data) => {
      if (disposed) return;
      if (event === "pty-exit") {
        const payload = data as { id: string };
        if (payload.id === ptyId) {
          xterm.write("\r\n\x1b[90mSession ended\x1b[0m\r\n");
        }
      }
    });

    // Handle resize — skip when container is CSS-hidden (reports 0 dimensions)
    const resizeObserver = new ResizeObserver(() => {
      if (disposed) return;
      const el = terminalRef.current;
      if (!el || el.offsetWidth === 0 || el.offsetHeight === 0) return;
      safeFit(fitAddon);
      if (ready) {
        ptyCommands.resize(ptyId, xterm.cols, xterm.rows).catch((err) => {
          console.error("Failed to resize PTY:", err);
        });
      }
    });
    resizeObserver.observe(terminalRef.current);

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      inputDisposable.dispose();
      unlistenData();
      unlistenExit();
      ptyCommands.kill(ptyId).catch(() => {
        /* Expected: PTY process may already be dead or cleaned up */
      });
      xterm.dispose();
    };
  }, [id, workspacePath, initialCommand]);

  // Refit terminal when becoming visible — container may have resized while hidden
  useEffect(() => {
    if (!visible || !fitAddonRef.current || !xtermRef.current) return;
    const frame = requestAnimationFrame(() => {
      if (fitAddonRef.current) safeFit(fitAddonRef.current);
    });
    return () => cancelAnimationFrame(frame);
  }, [visible]);

  return (
    <div className="terminal-container">
      <div ref={terminalRef} className="terminal" />
    </div>
  );
}
