import { isEmbeddableStreamUrl, toEmbeddedStreamUrl } from "./cloudSimulatorStream";

interface CloudSimulatorScreenProps {
  workspaceId: string;
  streamUrl: string;
  visible: boolean;
}

export function CloudSimulatorScreen({ streamUrl, visible }: CloudSimulatorScreenProps) {
  // Unmount the viewer while hidden so it stops decoding the live stream.
  if (!visible) return null;
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
