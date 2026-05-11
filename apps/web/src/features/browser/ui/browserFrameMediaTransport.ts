import { useCallback, useMemo, useRef } from "react";
import type { RefObject } from "react";
import type {
  BrowserProxyFrameEvent,
  BrowserProxyMediaTransport,
} from "@shared/types/browser-proxy";

export const BROWSER_FRAME_MEDIA_TRANSPORT: BrowserProxyMediaTransport = "websocket-frames";

export interface BrowserPoint {
  x: number;
  y: number;
}

export interface BrowserFrameMediaTransport {
  readonly kind: BrowserProxyMediaTransport;
  readonly canvasRef: RefObject<HTMLCanvasElement>;
  drawFrame: (frame: BrowserProxyFrameEvent, onDrawn?: () => void) => void;
  captureScreenshot: (rect?: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => string | null;
  pointFromClient: (clientX: number, clientY: number) => BrowserPoint;
}

function captureCanvasDataUrl(
  canvas: HTMLCanvasElement,
  rect?: { x: number; y: number; width: number; height: number }
): string | null {
  if (canvas.width <= 0 || canvas.height <= 0) return null;
  if (!rect) return canvas.toDataURL("image/png");

  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  if (x >= canvas.width || y >= canvas.height) return null;
  const width = Math.max(1, Math.min(canvas.width - x, Math.floor(rect.width)));
  const height = Math.max(1, Math.min(canvas.height - y, Math.floor(rect.height)));
  if (width <= 0 || height <= 0) return null;

  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(canvas, x, y, width, height, 0, 0, width, height);
  return out.toDataURL("image/png");
}

/**
 * Active browser media transport: WebSocket-delivered encoded frames rendered
 * into a canvas. Browser control stays outside this hook so the transport can
 * later be swapped for WebRTC/LiveKit without rewriting navigation/input/eval.
 */
export function useBrowserFrameMediaTransport(): BrowserFrameMediaTransport {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameSizeRef = useRef({ width: 1, height: 1 });
  const drawRequestRef = useRef(0);

  const drawFrame = useCallback((frame: BrowserProxyFrameEvent, onDrawn?: () => void) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const drawRequest = ++drawRequestRef.current;
    frameSizeRef.current = { width: frame.width, height: frame.height };
    if (canvas.width !== frame.width) canvas.width = frame.width;
    if (canvas.height !== frame.height) canvas.height = frame.height;
    const img = new Image();
    img.onload = () => {
      if (drawRequest !== drawRequestRef.current) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, frame.width, frame.height);
      onDrawn?.();
    };
    img.src = `data:image/${frame.format};base64,${frame.data}`;
  }, []);

  const captureScreenshot = useCallback(
    (rect?: { x: number; y: number; width: number; height: number }) => {
      const canvas = canvasRef.current;
      return canvas ? captureCanvasDataUrl(canvas, rect) : null;
    },
    []
  );

  const pointFromClient = useCallback((clientX: number, clientY: number): BrowserPoint => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const frame = frameSizeRef.current;
    return {
      x: ((clientX - rect.left) / Math.max(1, rect.width)) * frame.width,
      y: ((clientY - rect.top) / Math.max(1, rect.height)) * frame.height,
    };
  }, []);

  return useMemo(
    () => ({
      kind: BROWSER_FRAME_MEDIA_TRANSPORT,
      canvasRef,
      drawFrame,
      captureScreenshot,
      pointFromClient,
    }),
    [captureScreenshot, drawFrame, pointFromClient]
  );
}
