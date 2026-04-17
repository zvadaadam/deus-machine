import { useEffect, useRef, useState } from "react";
import { useSimStore } from "../stores/sim-store";
import { useActivityStore } from "../stores/activity-store";

interface Ripple {
  id: string;
  x: number;
  y: number;
  ts: number;
}

const SIM_POINT_WIDTH = 402; // approx iPhone pt width — TODO: fetch from /api/stream /config

export function DeviceFrame() {
  const { pinnedUdid, sims, streamInfo } = useSimStore();
  const pinnedSim = sims.find((s) => s.udid === pinnedUdid);
  const booted = pinnedSim?.state === "Booted";

  const imgRef = useRef<HTMLImageElement>(null);
  const imgRectRef = useRef<DOMRect | null>(null);
  const [ripples, setRipples] = useState<Ripple[]>([]);

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
        if (typeof params.x !== "number" || typeof params.y !== "number" || !rect) continue;
        const scale = rect.width / SIM_POINT_WIDTH;
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

  return (
    <div className="stage">
      <div className="device-frame">
        {booted && streamInfo ? (
          <img ref={imgRef} src={`/stream.mjpeg?ts=${streamInfo.udid}`} alt="simulator stream" />
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
