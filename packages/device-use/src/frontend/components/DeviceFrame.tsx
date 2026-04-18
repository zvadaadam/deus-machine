import { useCallback, useEffect, useRef, useState } from "react";
import { useSimStore } from "../stores/sim-store";
import { useRefsStore } from "../stores/refs-store";
import { api } from "../lib/api";

interface Ripple {
  id: number;
  x: number;
  y: number;
}

// Binary framing for simbridge's /ws protocol:
//   byte 0: message type (0x03 = touch, 0x04 = button)
//   bytes 1..: JSON payload
function encodeTouch(type: "begin" | "move" | "end", x: number, y: number): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify({ type, x, y }));
  const buf = new Uint8Array(1 + payload.length);
  buf[0] = 0x03;
  buf.set(payload, 1);
  return buf;
}

function encodeButton(button: string): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify({ button }));
  const buf = new Uint8Array(1 + payload.length);
  buf[0] = 0x04;
  buf.set(payload, 1);
  return buf;
}

interface HardwareButton {
  label: string;
  button: string;
  key?: string[];
}

const HARDWARE_BUTTONS: HardwareButton[] = [
  { label: "Home", button: "home", key: ["h", "H"] },
  { label: "Lock", button: "lock", key: ["l", "L"] },
];

/** Visual shell spec — bezel dimensions per device class.
 *
 *  The shell's aspect ratio is derived from the stream's point dimensions
 *  (streamInfo.size.ptW/ptH) so the content fills the screen box exactly
 *  regardless of which iPhone/iPad model is pinned. A fixed
 *  `430 / 932` looked wrong on iPhone Air (420×912) and iPhone 17 Pro Max
 *  (440×956). Percentage insets + rem radii scale automatically.
 *
 *  We do NOT draw dynamic island / camera hole overlays — the simulator's
 *  MJPEG stream already includes iOS's native status bar (with its own
 *  cutout). Drawing a second pill on top caused the "two islands stacked"
 *  artifact. The shell is the bezel only; the stream is the screen. */
interface ShellSpec {
  aspectRatio: string;
  shellRadius: string;
  screenRadius: string;
  screenInsets: { top: string; left: string; right: string; bottom: string };
}

const PHONE_INSETS = { top: 1.7, left: 2.5, right: 2.5, bottom: 1.9 }; // %
const TABLET_INSETS = { top: 2.1, left: 2.2, right: 2.2, bottom: 2.1 }; // %

function getShellSpec(
  deviceName: string | null | undefined,
  size: { ptW: number; ptH: number } | undefined
): ShellSpec {
  const isTablet = deviceName?.includes("iPad") ?? false;
  const insets = isTablet ? TABLET_INSETS : PHONE_INSETS;

  // Derive shell aspect ratio from the stream so the screen box matches
  // the stream's native ratio after subtracting the bezel insets.
  //
  //   shellW × (1 − (insetL+insetR)/100) = screenW
  //   shellH × (1 − (insetT+insetB)/100) = screenH
  //   screenAR = ptW / ptH   (from streamInfo.size)
  //   shellAR  = screenAR × (widthFrac / heightFrac)
  const widthFrac = 1 - (insets.left + insets.right) / 100;
  const heightFrac = 1 - (insets.top + insets.bottom) / 100;
  const screenAR = size ? size.ptW / size.ptH : isTablet ? 834 / 1194 : 430 / 932;
  const shellAR = (screenAR * widthFrac) / heightFrac;

  return {
    aspectRatio: `${shellAR}`,
    shellRadius: isTablet ? "2.75rem" : "3.25rem",
    screenRadius: isTablet ? "2.1rem" : "2.6rem",
    screenInsets: {
      top: `${insets.top}%`,
      left: `${insets.left}%`,
      right: `${insets.right}%`,
      bottom: `${insets.bottom}%`,
    },
  };
}

export function DeviceFrame() {
  const { pinnedUdid, sims, streamInfo } = useSimStore();
  const pinnedSim = sims.find((s) => s.udid === pinnedUdid);
  const booted = pinnedSim?.state === "Booted";
  // Primitive deps so the render + WS effects don't retear every time
  // sim-store polls /api/stream and writes a new streamInfo reference.
  const streamUdid = streamInfo?.udid;
  const streamPort = streamInfo?.port;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const dragRef = useRef(false);
  const rippleIdRef = useRef(0);
  const [ripples, setRipples] = useState<Ripple[]>([]);

  // --- MJPEG → canvas rendering -------------------------------------------
  useEffect(() => {
    if (!booted || !streamUdid) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = `/stream.mjpeg?ts=${streamUdid}`;

    let animId = 0;
    let prevW = 0;
    let prevH = 0;
    const draw = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (w > 0 && h > 0) {
        if (w !== prevW || h !== prevH) {
          canvas.width = w;
          canvas.height = h;
          prevW = w;
          prevH = h;
        }
        ctx.drawImage(img, 0, 0);
      }
      animId = requestAnimationFrame(draw);
    };
    draw();

    return () => {
      cancelAnimationFrame(animId);
      img.src = "";
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
    // Depend on primitive identity only — full streamInfo is a fresh
    // object on each /api/stream poll and would retear the canvas.
  }, [booted, streamUdid]);

  // --- WebSocket to /sim-input --------------------------------------------
  useEffect(() => {
    if (!booted || !streamUdid) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/sim-input`);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    return () => {
      wsRef.current = null;
      ws.close();
    };
  }, [booted, streamUdid, streamPort]);

  // --- Coordinate normalization + touch dispatch --------------------------
  /** Returns click-fractional coords [0..1] + the canvas rect, or null if
   *  the canvas/ws isn't ready. Works for both React.MouseEvent and
   *  native MouseEvent (window-level listener). */
  const normalize = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return {
      nx: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
      ny: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
      rect,
    };
  }, []);

  const sendTouch = useCallback(
    (type: "begin" | "move" | "end", clientX: number, clientY: number) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return null;
      const pt = normalize(clientX, clientY);
      if (!pt) return null;
      ws.send(encodeTouch(type, pt.nx, pt.ny));
      return pt;
    },
    [normalize]
  );

  const onMouseDown = useCallback(
    (ev: React.MouseEvent<HTMLCanvasElement>) => {
      if (ev.button !== 0) return;
      const info = sendTouch("begin", ev.clientX, ev.clientY);
      if (info) {
        dragRef.current = true;
        // Local ripple, immediate feedback — don't wait for round-trip.
        const id = ++rippleIdRef.current;
        const x = info.nx * info.rect.width;
        const y = info.ny * info.rect.height;
        setRipples((r) => [...r, { id, x, y }].slice(-8));
        setTimeout(() => setRipples((r) => r.filter((rr) => rr.id !== id)), 800);
      }
    },
    [sendTouch]
  );

  const onMouseMove = useCallback(
    (ev: React.MouseEvent<HTMLCanvasElement>) => {
      if (!dragRef.current || ev.buttons !== 1) return;
      sendTouch("move", ev.clientX, ev.clientY);
    },
    [sendTouch]
  );

  const onMouseUp = useCallback(
    (ev: React.MouseEvent<HTMLCanvasElement>) => {
      if (ev.button !== 0 || !dragRef.current) return;
      dragRef.current = false;
      sendTouch("end", ev.clientX, ev.clientY);
      // Screen likely changed — refresh the refs sidebar.
      useRefsStore.getState().scheduleRefresh();
    },
    [sendTouch]
  );

  // Hardware-button press — sends 0x04 binary frame to simbridge.
  const pressButton = useCallback((button: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(encodeButton(button));
    useRefsStore.getState().scheduleRefresh();
  }, []);

  // --- Keyboard → type_text -----------------------------------------------
  // simbridge's /ws protocol has no key opcode — we go through the REST
  // type_text tool instead. To avoid one HTTP round-trip per keystroke,
  // keys are buffered and flushed after a short idle or on Enter.
  const typedRef = useRef("");
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const flushTyped = useCallback(async (opts: { submit?: boolean } = {}) => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = undefined;
    }
    const text = typedRef.current;
    typedRef.current = "";
    if (!text && !opts.submit) return;
    await api.typeText({ text, submit: opts.submit });
    useRefsStore.getState().scheduleRefresh();
  }, []);

  useEffect(() => {
    if (!booted || !streamUdid) return;
    const onKey = (ev: KeyboardEvent) => {
      // Respect focus: let the top-bar inputs handle their own keystrokes.
      const tag = (ev.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      // Hardware button shortcuts (Cmd+H / Cmd+L) are handled elsewhere.
      if (ev.metaKey || ev.ctrlKey) return;
      if (ev.key === "Enter") {
        ev.preventDefault();
        void flushTyped({ submit: true });
        return;
      }
      if (ev.key === "Backspace") {
        ev.preventDefault();
        // Backspace only trims chars still queued on the client — it can't
        // undo characters already dispatched to the sim. Good enough for
        // typo-correction during fast typing; add a dedicated backspace
        // command if/when simbridge grows a key opcode.
        if (typedRef.current.length > 0) {
          typedRef.current = typedRef.current.slice(0, -1);
        }
        return;
      }
      if (ev.key.length === 1) {
        ev.preventDefault();
        typedRef.current += ev.key;
        if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
        flushTimerRef.current = setTimeout(() => void flushTyped(), 150);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      // Flush anything still queued on teardown.
      void flushTyped();
    };
  }, [booted, streamUdid, flushTyped]);

  // Keyboard shortcuts for the hardware buttons (Cmd+H → home, Cmd+L → lock).
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      // Ignore keys while typing in inputs.
      const tag = (ev.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (!(ev.metaKey || ev.ctrlKey)) return;
      for (const b of HARDWARE_BUTTONS) {
        if (b.key && b.key.includes(ev.key)) {
          ev.preventDefault();
          pressButton(b.button);
          return;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pressButton]);

  // Window-level mouseup catches drag-release that exits the canvas.
  useEffect(() => {
    const onWindowMouseUp = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      dragRef.current = false;
      sendTouch("end", ev.clientX, ev.clientY);
      useRefsStore.getState().scheduleRefresh();
    };
    window.addEventListener("mouseup", onWindowMouseUp);
    return () => window.removeEventListener("mouseup", onWindowMouseUp);
  }, [sendTouch]);

  const shell = getShellSpec(pinnedSim?.name, streamInfo?.size);

  return (
    <div className="stage">
      <div className="device-container">
        <div
          className="device-shell"
          style={{ aspectRatio: shell.aspectRatio, borderRadius: shell.shellRadius }}
        >
          {/* Subtle inner ring — catches light, hints at bezel thickness */}
          <div
            className="device-shell-ring"
            style={{ borderRadius: shell.shellRadius }}
            aria-hidden
          />

          <div
            className="device-screen"
            style={{
              top: shell.screenInsets.top,
              left: shell.screenInsets.left,
              right: shell.screenInsets.right,
              bottom: shell.screenInsets.bottom,
              borderRadius: shell.screenRadius,
            }}
          >
            {booted && streamInfo ? (
              <canvas
                ref={canvasRef}
                className="device-canvas"
                onMouseDown={onMouseDown}
                onMouseMove={onMouseMove}
                onMouseUp={onMouseUp}
                onContextMenu={(e) => e.preventDefault()}
              />
            ) : (
              <div className="phone-placeholder">
                {sims.length === 0
                  ? "No simulators found. Install iOS simulators via Xcode → Settings → Platforms."
                  : !pinnedUdid
                    ? "Pick a simulator from the top bar."
                    : !booted
                      ? "Click boot to start the simulator."
                      : "Waiting for stream…"}
              </div>
            )}
            {ripples.map((r) => (
              <span key={r.id} className="ripple" style={{ left: r.x, top: r.y }} />
            ))}
          </div>
        </div>
      </div>
      {booted && streamInfo && (
        <div className="device-buttons">
          {HARDWARE_BUTTONS.map((b) => (
            <button
              key={b.button}
              className="hw-button"
              onClick={() => pressButton(b.button)}
              title={b.key ? `${b.label} (⌘${b.key[0]?.toUpperCase()})` : b.label}
            >
              {b.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
