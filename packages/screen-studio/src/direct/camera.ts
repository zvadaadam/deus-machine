import { clamp, type Size } from "../util/units.js";
import type { CameraTokens } from "./presets.js";
import type { Camera, Shot } from "./shots.js";
import { Spring } from "./spring.js";

/**
 * Per-frame camera for a rendition, sprung in output time so motion speed is
 * what the viewer sees, not what the fast-forwarded source did. Zoom springs
 * in log space, where equal steps look equally large.
 */
export function cameraTrack(
  shots: Shot[],
  frames: number,
  fps: number,
  size: Size,
  tokens: CameraTokens
): Camera[] {
  const position = new Spring(tokens.position);
  const zoomSpring = new Spring(tokens.zoom);
  const first = shots[0]?.camera ?? { x: size.width / 2, y: size.height / 2, zoom: 1 };
  let x = first.x;
  let y = first.y;
  let logZoom = Math.log(first.zoom);
  let vx = 0;
  let vy = 0;
  let vz = 0;
  let active = 0;
  const dt = 1 / fps;
  const track: Camera[] = [];
  for (let i = 0; i < frames; i++) {
    const t = (i * 1000) / fps;
    while (active + 1 < shots.length && shots[active + 1].atMs <= t) active++;
    const target = shots[active]?.camera ?? first;
    if (i > 0) {
      [x, vx] = position.step(x, vx, target.x, dt);
      [y, vy] = position.step(y, vy, target.y, dt);
      [logZoom, vz] = zoomSpring.step(logZoom, vz, Math.log(target.zoom), dt);
    }
    const zoom = clamp(Math.exp(logZoom), 1, Math.max(1, tokens.maxZoom));
    const halfW = size.width / zoom / 2;
    const halfH = size.height / zoom / 2;
    track.push({
      x: clamp(x, halfW, size.width - halfW),
      y: clamp(y, halfH, size.height - halfH),
      zoom,
    });
  }
  return track;
}
