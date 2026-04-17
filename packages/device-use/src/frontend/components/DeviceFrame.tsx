import { useEffect, useRef, useState } from "react";
import { useSimStore } from "../stores/sim-store";
import { useActivityStore } from "../stores/activity-store";
import { api } from "../lib/api";

interface Ripple {
  id: string;
  x: number;
  y: number;
  ts: number;
}

export function DeviceFrame() {
  const { pinnedUdid, sims, streamInfo } = useSimStore();
  const pinnedSim = sims.find((s) => s.udid === pinnedUdid);
  const booted = pinnedSim?.state === "Booted";
  const size = streamInfo?.size;

  const imgRef = useRef<HTMLImageElement>(null);
  const imgRectRef = useRef<DOMRect | null>(null);
  const [ripples, setRipples] = useState<Ripple[]>([]);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);

  // Track image bounds for ripple positioning — kept in a ref (no render on change).
  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    imgRectRef.current = img.getBoundingClientRect();
    const obs = new ResizeObserver(() => {
      imgRectRef.current = img.getBoundingClientRect();
    });
    obs.observe(img);
    return () => obs.disconnect();
  }, [streamInfo]);

  // Subscribe to new tap events via Zustand. setState inside a subscription
  // callback is fine; ESLint's set-state-in-effect only flags direct calls.
  useEffect(() => {
    const seenIds = new Set<string>();
    const unsubscribe = useActivityStore.subscribe((state) => {
      const taps = state.events.filter(
        (e) => e.tool === "tap" && e.status === "started" && !seenIds.has(e.id)
      );
      for (const e of taps) {
        seenIds.add(e.id);
        const params = e.params as { x?: number; y?: number; ref?: string };
        const rect = imgRectRef.current;
        const ptW = useSimStore.getState().streamInfo?.size?.ptW;
        if (typeof params.x !== "number" || typeof params.y !== "number" || !rect || !ptW) continue;
        const scale = rect.width / ptW;
        const ripple: Ripple = {
          id: e.id,
          x: params.x * scale,
          y: params.y * scale,
          ts: Date.now(),
        };
        setRipples((r) => [...r, ripple].slice(-8));
        setTimeout(() => setRipples((r) => r.filter((x) => x.id !== ripple.id)), 800);
      }
    });
    return unsubscribe;
  }, []);

  // Convert a click event on the image into simulator point coordinates.
  function cssToPoint(ev: React.MouseEvent<HTMLImageElement>): { x: number; y: number } | null {
    if (!size || !pinnedUdid) return null;
    const rect = ev.currentTarget.getBoundingClientRect();
    const cssX = ev.clientX - rect.left;
    const cssY = ev.clientY - rect.top;
    return {
      x: (cssX / rect.width) * size.ptW,
      y: (cssY / rect.height) * size.ptH,
    };
  }

  async function onMouseDown(ev: React.MouseEvent<HTMLImageElement>) {
    if (ev.button !== 0) return;
    const p = cssToPoint(ev);
    if (!p) return;
    setDragStart(p);
  }

  async function onMouseUp(ev: React.MouseEvent<HTMLImageElement>) {
    if (ev.button !== 0 || !dragStart) return;
    const end = cssToPoint(ev);
    setDragStart(null);
    if (!end || !pinnedUdid) return;
    const dx = end.x - dragStart.x;
    const dy = end.y - dragStart.y;
    const dist = Math.hypot(dx, dy);
    try {
      if (dist < 8) {
        // Treat as tap — sub-8pt movement is noise.
        await api.tap({ x: dragStart.x, y: dragStart.y, udid: pinnedUdid });
      } else {
        // Swipe.
        await fetch("/api/tools/swipe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fromX: dragStart.x,
            fromY: dragStart.y,
            toX: end.x,
            toY: end.y,
            udid: pinnedUdid,
          }),
        });
      }
    } catch {
      // Tool errors surface via the activity feed; swallow here.
    }
  }

  return (
    <div className="stage">
      <div className="device-frame">
        {booted && streamInfo ? (
          <img
            ref={imgRef}
            src={`/stream.mjpeg?ts=${streamInfo.udid}`}
            alt="simulator stream"
            style={{ cursor: size ? "crosshair" : "default" }}
            draggable={false}
            onMouseDown={onMouseDown}
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
