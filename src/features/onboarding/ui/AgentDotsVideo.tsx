import { useCallback, useRef } from "react";

export interface AgentDotsVideoProps {
  /** Width/height of the container in CSS pixels. */
  size?: number;
  /** Use WebM with alpha (transparent) or MP4 (black bg). Defaults to "webm". */
  format?: "webm" | "mp4";
  /** Loop the video. Defaults to false. */
  loop?: boolean;
  /** Start playing immediately. Defaults to true. */
  autoPlay?: boolean;
  /** Called when the video ends (not called if looping). */
  onComplete?: () => void;
  className?: string;
}

const SOURCES = {
  webm: "/animations/agent-dots-alpha.webm",
  mp4: "/animations/agent-dots.mp4",
} as const;

export function AgentDotsVideo({
  size,
  format = "webm",
  loop = false,
  autoPlay = true,
  onComplete,
  className,
}: AgentDotsVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  const handleEnded = useCallback(() => {
    onComplete?.();
  }, [onComplete]);

  return (
    <div
      className={className}
      style={{
        width: size,
        height: size,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <video
        ref={videoRef}
        src={SOURCES[format]}
        autoPlay={autoPlay}
        loop={loop}
        muted
        playsInline
        onEnded={handleEnded}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "contain",
        }}
      />
    </div>
  );
}
