/**
 * The device stream inside the frame. On the desktop it is a bare <webview>
 * (webview-manager keeps the element in document.body, positioned over this
 * placeholder, so tab and workspace switches don't reload the guest); the
 * web build embeds the same URL in an iframe. The parent keys this by URL: a
 * new stream URL is a new device — dispose and start clean rather than
 * navigate a guest that belongs to a device that no longer exists.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { capabilities } from "@/platform/capabilities";
import { useWebview } from "@/features/browser/hooks/useWebview";
import { webviewManager, type Bounds } from "@/features/browser/webview-manager";

interface CloudSimulatorScreenProps {
  workspaceId: string;
  streamUrl: string;
  visible: boolean;
}

export function CloudSimulatorScreen(props: CloudSimulatorScreenProps) {
  return capabilities.nativeBrowser ? (
    <NativeStream {...props} />
  ) : (
    <iframe
      title="Cloud device"
      src={props.streamUrl}
      className="bg-bg-base h-full w-full border-0"
      allow="autoplay; clipboard-read; clipboard-write"
    />
  );
}

/** How far up the frame's rounded screen sits: DeviceFrame wraps children in
 *  one relative div inside the rounded, overflow-hidden screen div. */
const SCREEN_ANCESTOR_DEPTH = 2;

function NativeStream({ workspaceId, streamUrl, visible }: CloudSimulatorScreenProps) {
  const id = `cloud-sim-${workspaceId}`;
  const placeholderRef = useRef<HTMLDivElement | null>(null);
  const [bounds, setBounds] = useState<Bounds | null>(null);

  // Same measurement the Browser tab does: the webview is position:fixed in
  // document.body, so anything that moves this placeholder (panel resize,
  // window resize, a scrolling ancestor) must re-derive its screen rect.
  useLayoutEffect(() => {
    const el = placeholderRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      setBounds({ x: r.x, y: r.y, width: r.width, height: r.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, []);

  const { getInstance } = useWebview({ id, initialUrl: streamUrl, bounds, isVisible: visible });

  // The frame's rounded corners are an overflow clip on a React-tree ancestor,
  // which never reaches an element living in document.body — so mirror the
  // screen's radius (and corner shape) onto the webview's container. The
  // container's box IS the screen rect, so the percentage radii resolve to the
  // same pixels. Style is set once; sync() never resets these properties.
  useLayoutEffect(() => {
    const container = getInstance()?.container;
    let screen: HTMLElement | null = placeholderRef.current;
    for (let i = 0; i < SCREEN_ANCESTOR_DEPTH && screen; i++) screen = screen.parentElement;
    if (!container || !screen) return;
    const source = screen.style as CSSStyleDeclaration & { cornerShape?: string };
    const target = container.style as CSSStyleDeclaration & { cornerShape?: string };
    target.borderRadius = source.borderRadius;
    if (source.cornerShape !== undefined) target.cornerShape = source.cornerShape;
    target.overflow = "hidden";
  }, [getInstance]);

  // Unlike a Browser tab, a device stream has no life outside this panel:
  // when it unmounts (URL change, Stop, workspace switch) the guest goes too.
  useEffect(() => () => webviewManager.dispose(id), [id]);

  return <div ref={placeholderRef} className="h-full w-full" />;
}
