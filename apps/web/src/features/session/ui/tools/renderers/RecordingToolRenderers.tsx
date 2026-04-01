/**
 * Recording Tool Renderers
 *
 * - recording_start → minimal status row
 * - recording_stop → prominent video card in chat, click opens modal player
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { Video, Play, Pause, X, Film } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { createPortal } from "react-dom";
import { BaseToolRenderer } from "../components";
import { TOOL_ICON_CLS } from "../toolColors";
import { cn } from "@/shared/lib/utils";
import { getBaseURL } from "@/shared/config/api.config";
import * as browserViews from "@/platform/native/browser-views";
import type { ToolRendererProps } from "../../chat-types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MappedChapter {
  title: string;
  time: number;
}

interface MappedEvent {
  type: string;
  time: number;
  text?: string;
  url?: string;
  direction?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseResultJson(toolResult?: { content?: unknown }): Record<string, unknown> | null {
  if (!toolResult?.content) return null;
  let text = "";
  if (typeof toolResult.content === "string") {
    text = toolResult.content;
  } else if (Array.isArray(toolResult.content)) {
    const textBlock = toolResult.content.find(
      (b: Record<string, unknown>) => b?.type === "text" && typeof b.text === "string"
    );
    if (textBlock) text = (textBlock as { text: string }).text;
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs.toFixed(0)}s`;
}

function useStreamUrl(filePath: string | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!filePath) return;
    let cancelled = false;
    getBaseURL()
      .then((base) => {
        if (!cancelled) setUrl(`${base}/files/stream?path=${encodeURIComponent(filePath)}`);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [filePath]);
  return url;
}

const EVENT_LABELS: Record<string, string> = {
  click: "Click",
  type: "Type",
  scroll: "Scroll",
  navigate: "Navigate",
  drag: "Drag",
};

function eventLabel(event: MappedEvent): string {
  const base = EVENT_LABELS[event.type] ?? event.type;
  if (event.type === "navigate" && event.url) {
    try {
      const parsed = new URL(event.url);
      const path = parsed.pathname.replace(/\/$/, ""); // strip trailing slash
      if (!path || path === "") {
        return `Navigate → ${parsed.hostname}`;
      }
      const full = `${parsed.hostname}${path}`;
      // Truncate long paths: keep hostname + first segment + ellipsis
      if (full.length > 35) {
        const segments = path.split("/").filter(Boolean);
        if (segments.length > 1) {
          return `Navigate → ${parsed.hostname}/${segments[0]}/…`;
        }
        return `Navigate → ${full.slice(0, 32)}…`;
      }
      return `Navigate → ${full}`;
    } catch {
      return base;
    }
  }
  if (event.type === "type" && event.text) {
    const preview = event.text.length > 25 ? event.text.slice(0, 25) + "…" : event.text;
    return `Type "${preview}"`;
  }
  if (event.type === "scroll" && event.direction) {
    return `Scroll ${event.direction}`;
  }
  return base;
}

// ---------------------------------------------------------------------------
// recording_start
// ---------------------------------------------------------------------------

export function RecordingStartToolRenderer({ toolUse, toolResult, isLoading }: ToolRendererProps) {
  const result = parseResultJson(toolResult);
  const sessionId = result?.sessionId as string | undefined;

  return (
    <BaseToolRenderer
      toolName="Start Recording"
      icon={<Video className={cn(TOOL_ICON_CLS, "text-muted-foreground")} />}
      toolUse={toolUse}
      toolResult={toolResult}
      isLoading={isLoading}
      renderSummary={() =>
        sessionId ? (
          <code className="text-muted-foreground font-mono text-xs">{sessionId}</code>
        ) : null
      }
    />
  );
}

// ---------------------------------------------------------------------------
// recording_stop
// ---------------------------------------------------------------------------

export function RecordingStopToolRenderer({ toolUse, toolResult, isLoading }: ToolRendererProps) {
  const result = parseResultJson(toolResult);
  const outputPath = result?.outputPath as string | undefined;
  const thumbnailPath = result?.thumbnailPath as string | undefined;
  const duration = result?.duration as number | undefined;
  const chapters = (result?.chapters as MappedChapter[] | undefined) ?? [];
  const events = (result?.events as MappedEvent[] | undefined) ?? [];
  const eventCount = (result?.eventCount as number | undefined) ?? events.length;

  const hasVideo = !!outputPath && outputPath.length > 0;
  const [modalOpen, setModalOpen] = useState(false);

  // Loading / no result
  if (isLoading || !toolResult) {
    return (
      <BaseToolRenderer
        toolName="Screen Recording"
        icon={<Video className={cn(TOOL_ICON_CLS, "text-primary")} />}
        toolUse={toolUse}
        toolResult={toolResult}
        isLoading={isLoading}
      />
    );
  }

  // Error
  if (toolResult.is_error) {
    return (
      <BaseToolRenderer
        toolName="Screen Recording"
        icon={<Video className={cn(TOOL_ICON_CLS, "text-primary")} />}
        toolUse={toolUse}
        toolResult={toolResult}
        showContentOnError
      />
    );
  }

  // No video
  if (!hasVideo) {
    return (
      <BaseToolRenderer
        toolName="Screen Recording"
        icon={<Video className={cn(TOOL_ICON_CLS, "text-primary")} />}
        toolUse={toolUse}
        toolResult={toolResult}
        renderSummary={() => (
          <span className="text-muted-foreground text-xs italic">events-only, no video</span>
        )}
      />
    );
  }

  // Video available — use BaseToolRenderer as structural host but make the card prominent.
  // BaseToolRenderer is required because the parent ToolUseBlock uses CSS containment
  // that collapses content rendered outside it.
  return (
    <BaseToolRenderer
      toolName="Screen Recording"
      icon={<Film className={cn(TOOL_ICON_CLS, "text-primary")} />}
      toolUse={toolUse}
      toolResult={toolResult}
      defaultExpanded
      fullWidthContent
      renderSummary={() =>
        duration != null ? (
          <span className="text-muted-foreground text-sm">{formatDuration(duration)}</span>
        ) : null
      }
    >
      <RecordingCard
        thumbnailPath={thumbnailPath}
        duration={duration}
        eventCount={eventCount}
        onClick={() => setModalOpen(true)}
      />

      <AnimatePresence>
        {modalOpen && (
          <VideoModal
            outputPath={outputPath}
            thumbnailPath={thumbnailPath}
            duration={duration}
            chapters={chapters}
            events={events}
            eventCount={eventCount}
            onClose={() => setModalOpen(false)}
          />
        )}
      </AnimatePresence>
    </BaseToolRenderer>
  );
}

// ---------------------------------------------------------------------------
// RecordingCard — prominent inline card in chat flow
// ---------------------------------------------------------------------------

function RecordingCard({
  thumbnailPath,
  duration,
  eventCount,
  onClick,
}: {
  thumbnailPath?: string;
  duration?: number;
  eventCount: number;
  onClick: () => void;
}) {
  const thumbUrl = useStreamUrl(thumbnailPath);

  return (
    <button
      type="button"
      className={cn(
        "border-border/40 group relative overflow-hidden rounded-xl border text-left",
        "bg-background",
        "cursor-pointer transition-all duration-200",
        "hover:border-border/60 hover:shadow-lg"
      )}
      style={{ width: "100%", minWidth: "400px" }}
      onClick={onClick}
      aria-label="Open recording player"
    >
      {/* Thumbnail container — 16:9 */}
      <div className="relative" style={{ width: "100%", paddingBottom: "56.25%" }}>
        {/* Thumbnail image */}
        {thumbUrl ? (
          <img
            src={thumbUrl}
            alt="Recording thumbnail"
            className="absolute inset-0 h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.02]"
          />
        ) : (
          <div className="bg-muted absolute inset-0" />
        )}

        {/* Center play button */}
        <div className="absolute inset-0 flex items-center justify-center">
          <div
            className={cn(
              "flex h-14 w-14 items-center justify-center rounded-full",
              "bg-black/50 shadow-lg backdrop-blur-md",
              "transition-all duration-200 ease-out",
              "group-hover:scale-110 group-hover:bg-black/60"
            )}
          >
            <Play className="ml-1 h-6 w-6 fill-white text-white" />
          </div>
        </div>

        {/* Bottom gradient bar */}
        <div className="from-background/90 via-background/50 absolute right-0 bottom-0 left-0 flex items-end justify-between bg-gradient-to-t to-transparent px-4 pt-10 pb-3">
          {/* Left: label + event count */}
          <div className="flex items-center gap-2">
            <Film className="text-muted-foreground h-3.5 w-3.5" />
            <span className="text-foreground text-[13px] font-medium">Screen Recording</span>
            {eventCount > 0 && (
              <>
                <span className="text-muted-foreground/50">·</span>
                <span className="text-muted-foreground text-[13px]">{eventCount} events</span>
              </>
            )}
          </div>

          {/* Right: duration badge */}
          {duration != null && (
            <span className="bg-muted/80 text-foreground rounded-md px-2 py-0.5 text-[13px] font-medium tabular-nums backdrop-blur-sm">
              {formatDuration(duration)}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// VideoModal — overlay player with metadata sidebar
// ---------------------------------------------------------------------------

function VideoModal({
  outputPath,
  thumbnailPath,
  duration,
  chapters,
  events,
  eventCount,
  onClose,
}: {
  outputPath: string;
  thumbnailPath?: string;
  duration?: number;
  chapters: MappedChapter[];
  events: MappedEvent[];
  eventCount: number;
  onClose: () => void;
}) {
  const videoUrl = useStreamUrl(outputPath);
  const thumbUrl = useStreamUrl(thumbnailPath);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);

  const totalDuration = duration ?? 0;
  const hasChapters = chapters.length > 0;
  const meaningfulEvents = events.filter((e) => e.type !== "idle" && e.type !== "screenshot");

  // Hide native BrowserViews (they render above web content)
  useEffect(() => {
    browserViews.hideAll();
    return () => {
      browserViews.showAll();
    };
  }, []);

  // Auto-play
  useEffect(() => {
    if (videoRef.current && videoUrl) {
      videoRef.current.play().catch(() => {});
    }
  }, [videoUrl]);

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const seekTo = useCallback(
    (time: number) => {
      if (!videoRef.current) return;
      videoRef.current.currentTime = time;
      if (!playing) videoRef.current.play().catch(() => {});
    },
    [playing]
  );

  const handlePlayPause = useCallback(() => {
    if (!videoRef.current) return;
    if (playing) videoRef.current.pause();
    else videoRef.current.play().catch(() => {});
  }, [playing]);

  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.92, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.92, opacity: 0 }}
        transition={{ duration: 0.25, ease: [0.165, 0.84, 0.44, 1] }}
        className="bg-background border-border/40 relative flex max-h-[85vh] w-[90vw] max-w-5xl flex-col overflow-hidden rounded-xl border shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Close button */}
        <button
          type="button"
          onClick={onClose}
          className="absolute top-3 right-3 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-black/40 text-white/80 backdrop-blur-sm transition-colors duration-150 hover:bg-black/60 hover:text-white"
          aria-label="Close player"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="flex min-h-0 flex-1">
          {/* Video panel */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div
              className="relative w-full cursor-pointer bg-black"
              style={{ aspectRatio: "16 / 9" }}
              onClick={handlePlayPause}
            >
              {videoUrl && (
                <video
                  ref={videoRef}
                  src={videoUrl}
                  poster={thumbUrl ?? undefined}
                  className="absolute inset-0 h-full w-full object-contain"
                  onEnded={() => setPlaying(false)}
                  onPause={() => setPlaying(false)}
                  onPlay={() => setPlaying(true)}
                  onTimeUpdate={() => {
                    if (videoRef.current) setCurrentTime(videoRef.current.currentTime);
                  }}
                  preload="auto"
                />
              )}

              {/* Play/Pause overlay */}
              <div
                className={cn(
                  "absolute inset-0 flex items-center justify-center transition-opacity duration-200",
                  playing ? "opacity-0 hover:opacity-100" : "opacity-100"
                )}
              >
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-white/20 backdrop-blur-sm">
                  {playing ? (
                    <Pause className="h-6 w-6 fill-white text-white" />
                  ) : (
                    <Play className="ml-1 h-6 w-6 fill-white text-white" />
                  )}
                </div>
              </div>

              {/* Time */}
              {totalDuration > 0 && (
                <div className="absolute right-3 bottom-3 rounded bg-black/70 px-2 py-1 text-xs font-medium text-white">
                  {formatTime(currentTime)} / {formatTime(totalDuration)}
                </div>
              )}
            </div>

            {/* Progress bar */}
            {totalDuration > 0 && (
              <ProgressBar
                duration={totalDuration}
                currentTime={currentTime}
                chapters={chapters}
                onSeek={seekTo}
              />
            )}
          </div>

          {/* Metadata sidebar */}
          {(meaningfulEvents.length > 0 || hasChapters) && (
            <div className="border-border/40 flex w-64 flex-shrink-0 flex-col border-l">
              <div className="text-muted-foreground px-3 pt-3 pb-2 text-[11px] font-semibold tracking-wider uppercase">
                Timeline
              </div>
              <div className="chat-scroll-contain flex-1 overflow-y-auto">
                {hasChapters
                  ? chapters.map((ch, i) => {
                      const chapterEvents = meaningfulEvents.filter((e) => {
                        const nextChapter = chapters[i + 1];
                        return e.time >= ch.time && (!nextChapter || e.time < nextChapter.time);
                      });
                      return (
                        <div key={i} className="border-border/20 border-b last:border-b-0">
                          <button
                            type="button"
                            className="text-foreground hover:bg-muted/40 flex w-full items-baseline gap-2 px-3 py-2 text-left text-xs font-medium transition-colors"
                            onClick={() => seekTo(ch.time)}
                          >
                            <span className="text-muted-foreground flex-shrink-0 font-mono text-[10px]">
                              {formatTime(ch.time)}
                            </span>
                            <span className="truncate">{ch.title}</span>
                          </button>
                          {chapterEvents.map((evt, j) => (
                            <button
                              key={j}
                              type="button"
                              className="text-muted-foreground hover:bg-muted/30 hover:text-foreground flex w-full items-baseline gap-2 px-3 py-1 pl-6 text-left text-[11px] transition-colors"
                              onClick={() => seekTo(evt.time)}
                            >
                              <span className="flex-shrink-0 font-mono text-[10px]">
                                {formatTime(evt.time)}
                              </span>
                              <span className="truncate">{eventLabel(evt)}</span>
                            </button>
                          ))}
                        </div>
                      );
                    })
                  : meaningfulEvents.map((evt, i) => (
                      <button
                        key={i}
                        type="button"
                        className="text-muted-foreground hover:bg-muted/30 hover:text-foreground flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-[11px] transition-colors"
                        onClick={() => seekTo(evt.time)}
                      >
                        <span className="flex-shrink-0 font-mono text-[10px]">
                          {formatTime(evt.time)}
                        </span>
                        <span className="truncate">{eventLabel(evt)}</span>
                      </button>
                    ))}
              </div>
              <div className="border-border/40 text-muted-foreground flex items-center gap-2 border-t px-3 py-2 text-[11px]">
                {eventCount > 0 && <span>{eventCount} events</span>}
                {eventCount > 0 && hasChapters && <span>·</span>}
                {hasChapters && <span>{chapters.length} chapters</span>}
              </div>
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>,
    document.body
  );
}

// ---------------------------------------------------------------------------
// ProgressBar
// ---------------------------------------------------------------------------

function ProgressBar({
  duration,
  currentTime,
  chapters,
  onSeek,
}: {
  duration: number;
  currentTime: number;
  chapters: MappedChapter[];
  onSeek: (time: number) => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);

  const handleClick = (e: React.MouseEvent) => {
    if (!barRef.current) return;
    const rect = barRef.current.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    onSeek(pct * duration);
  };

  if (chapters.length === 0) {
    const progress = (currentTime / duration) * 100;
    return (
      <div
        ref={barRef}
        className="bg-muted/50 group relative h-1.5 cursor-pointer transition-[height] duration-150 hover:h-2.5"
        onClick={handleClick}
      >
        <div
          className="bg-primary absolute inset-y-0 left-0 transition-[width] duration-75 ease-linear"
          style={{ width: `${progress}%` }}
        />
      </div>
    );
  }

  const segments = chapters.map((ch, i) => ({
    ...ch,
    start: ch.time,
    end: i < chapters.length - 1 ? chapters[i + 1].time : duration,
  }));

  return (
    <div
      ref={barRef}
      className="group flex h-1.5 cursor-pointer gap-px transition-[height] duration-150 hover:h-2.5"
      onClick={handleClick}
    >
      {segments.map((seg, i) => {
        const segWidth = ((seg.end - seg.start) / duration) * 100;
        const progress =
          currentTime >= seg.end
            ? 100
            : currentTime >= seg.start
              ? ((currentTime - seg.start) / (seg.end - seg.start)) * 100
              : 0;

        return (
          <div
            key={i}
            className="bg-muted-foreground/20 relative h-full overflow-hidden"
            style={{ width: `${segWidth}%` }}
          >
            <div
              className="bg-primary absolute inset-y-0 left-0 transition-[width] duration-75 ease-linear"
              style={{ width: `${progress}%` }}
            />
          </div>
        );
      })}
    </div>
  );
}
