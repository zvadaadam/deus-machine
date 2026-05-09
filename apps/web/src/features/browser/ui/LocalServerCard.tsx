/**
 * LocalServerCard — single row in the browser empty-state list of detected
 * local dev servers. Click navigates the active tab to the server URL.
 */

import { memo } from "react";
import type { LocalServer } from "@shared/types";

interface LocalServerCardProps {
  server: LocalServer;
  onOpen: (url: string) => void;
}

export const LocalServerCard = memo(function LocalServerCard({
  server,
  onOpen,
}: LocalServerCardProps) {
  const subtitle = `${server.host}:${server.port}`;
  const title = server.title ?? subtitle;

  return (
    <button
      type="button"
      onClick={() => onOpen(server.url)}
      className="border-border-subtle bg-bg-elevated hover:bg-muted/40 focus-visible:ring-primary/40 group flex w-full items-center gap-3 rounded-lg border p-2 text-left transition-colors focus:outline-none focus-visible:ring-2"
      aria-label={`Open ${title} (${subtitle})`}
    >
      <PreviewThumbnail src={server.previewImageDataUrl} alt="" />

      <div className="min-w-0 flex-1">
        <div className="text-foreground truncate text-sm font-medium">{title}</div>
        <div className="text-muted-foreground truncate text-xs">{subtitle}</div>
      </div>

      <StatusDot status={server.status} />
    </button>
  );
});

function PreviewThumbnail({ src, alt }: { src: string | null; alt: string }) {
  // Fixed-size frame so cards align even when a probe didn't return a preview.
  if (!src) {
    return <div className="bg-muted/50 h-[38px] w-[60px] shrink-0 rounded-md" aria-hidden />;
  }
  return (
    <img
      src={src}
      alt={alt}
      width={60}
      height={38}
      className="h-[38px] w-[60px] shrink-0 rounded-md object-cover"
      draggable={false}
    />
  );
}

function StatusDot({ status }: { status: LocalServer["status"] }) {
  const isRunning = status === "running";
  return (
    <span
      className={
        "inline-block h-2 w-2 shrink-0 rounded-full " +
        (isRunning ? "bg-success" : "bg-muted-foreground/40")
      }
      role="img"
      aria-label={isRunning ? "Running" : "Offline"}
    />
  );
}
