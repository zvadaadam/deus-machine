import { useCallback, useEffect, useRef, useState } from "react";
import { useSimStore } from "../stores/sim-store";
import { useRefsStore } from "../stores/refs-store";

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

export function DeviceFrame() {
  const { pinnedUdid, sims, streamInfo } = useSimStore();
  const pinnedSim = sims.find((s) => s.udid === pinnedUdid);
  const booted = pinnedSim?.state === "Booted";

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const dragRef = useRef(false);
  const rippleIdRef = useRef(0);
  const [ripples, setRipples] = useState<Ripple[]>([]);

  // --- MJPEG → canvas rendering -------------------------------------------
  useEffect(() => {
    if (!booted || !streamInfo) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = `/stream.mjpeg?ts=${streamInfo.udid}`;

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
  }, [booted, streamInfo]);

  // --- WebSocket to /sim-input --------------------------------------------
  useEffect(() => {
    if (!booted || !streamInfo) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/sim-input`);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    return () => {
      wsRef.current = null;
      ws.close();
    };
  }, [booted, streamInfo]);

  // --- Coordinate normalization + touch dispatch --------------------------
  const sendTouch = useCallback((type: "begin" | "move" | "end", ev: React.MouseEvent) => {
    const canvas = canvasRef.current;
    const ws = wsRef.current;
    if (!canvas || !ws || ws.readyState !== WebSocket.OPEN) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const nx = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
    const ny = Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height));
    ws.send(encodeTouch(type, nx, ny));
    return { nx, ny, rect };
  }, []);

  const onMouseDown = useCallback(
    (ev: React.MouseEvent<HTMLCanvasElement>) => {
      if (ev.button !== 0) return;
      const info = sendTouch("begin", ev);
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
      sendTouch("move", ev);
    },
    [sendTouch]
  );

  const onMouseUp = useCallback(
    (ev: React.MouseEvent<HTMLCanvasElement>) => {
      if (ev.button !== 0 || !dragRef.current) return;
      dragRef.current = false;
      sendTouch("end", ev);
      // Screen likely changed — refresh the refs sidebar.
      useRefsStore.getState().scheduleRefresh(500);
    },
    [sendTouch]
  );

  // Window-level mouseup in case the cursor leaves the canvas mid-drag.
  useEffect(() => {
    const onWindowMouseUp = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      dragRef.current = false;
      const canvas = canvasRef.current;
      const ws = wsRef.current;
      if (!canvas || !ws || ws.readyState !== WebSocket.OPEN) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const nx = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      const ny = Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height));
      ws.send(encodeTouch("end", nx, ny));
      useRefsStore.getState().scheduleRefresh(500);
    };
    window.addEventListener("mouseup", onWindowMouseUp);
    return () => window.removeEventListener("mouseup", onWindowMouseUp);
  }, []);

  return (
    <div className="stage">
      <div className="device-frame">
        {booted && streamInfo ? (
          <canvas
            ref={canvasRef}
            className="device-canvas"
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
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
  );
}
