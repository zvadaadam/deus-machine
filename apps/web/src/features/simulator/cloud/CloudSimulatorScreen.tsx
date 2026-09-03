/**
 * The device stream — the EAS Simulator web preview, a WebRTC viewer,
 * embedded as an iframe that fills the panel's stage. The viewer draws the
 * device itself (skin, touch, rotation) and centers it in whatever room it
 * gets, so no frame of ours wraps it.
 *
 * Desktop used to host this in an Electron <webview> to survive tab switches
 * without reloading. A <webview> guest, though, will not autoplay the WebRTC
 * video — it renders blank — while an iframe in the app renderer plays it
 * fine (verified against a live EAS device). So both builds use the iframe;
 * a tab switch reloads the stream, an acceptable trade for a view that only
 * exists while the ephemeral device is up.
 *
 * The parent keys this by URL: a new stream URL is a new device, so React
 * remounts the iframe rather than pointing it at a device that is gone.
 */

import { isEmbeddableStreamUrl, toEmbeddedStreamUrl } from "./cloudSimulatorStream";

interface CloudSimulatorScreenProps {
  workspaceId: string;
  streamUrl: string;
  visible: boolean;
}

export function CloudSimulatorScreen({ streamUrl }: CloudSimulatorScreenProps) {
  if (!isEmbeddableStreamUrl(streamUrl)) {
    return (
      <div className="text-text-secondary flex h-full w-full items-center justify-center text-sm">
        This device stream can&apos;t be embedded here.
      </div>
    );
  }
  return (
    <iframe
      title="Cloud device"
      // `?embed=1` strips the EAS viewer's own toolbar and pill — Deus frames
      // and controls the device itself.
      src={toEmbeddedStreamUrl(streamUrl)}
      className="h-full w-full border-0 bg-transparent"
      // WebRTC video autoplays only if the permission is carried into the frame.
      allow="autoplay; clipboard-read; clipboard-write"
      // Scripts on the stream's own origin and nothing else: no top-level
      // navigation, downloads or popups out of a platform-supplied URL.
      // `allow-same-origin` restores the STREAM's origin (its viewer needs its
      // storage and WebRTC signalling socket); isEmbeddableStreamUrl keeps it a
      // foreign https origin, so no document in this frame can reach up and
      // lift the sandbox.
      sandbox="allow-scripts allow-same-origin"
      referrerPolicy="no-referrer"
    />
  );
}
