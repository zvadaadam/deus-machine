import { useRef, useState } from "react";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRuntimeClient, runtimeForQueryClient } from "@/platform/ws";
import { readMediaUrl, type FileLocation } from "./fileUrl";

type Media = HTMLImageElement | HTMLVideoElement;
interface Recovery {
  element: Media;
  time: number;
  playing: boolean;
  phase: "asked" | "reloading" | "restored";
}

export function useFileUrl(...file: FileLocation | [kind: "recording", path: undefined]) {
  const runtime = runtimeForQueryClient(useQueryClient()) ?? getRuntimeClient();
  const {
    data: url,
    isError,
    refetch,
  } = useQuery({
    queryKey: ["fileUrl", ...file],
    queryFn:
      file[1] !== undefined ? ({ signal }) => readMediaUrl(runtime, file, signal) : skipToken,
    staleTime: Infinity,
    retry: false,
  });
  const retry = useRef<Recovery | null>(null);
  const [failedUrl, setFailedUrl] = useState<string>();

  async function onError(element: Media) {
    if (retry.current?.element === element) {
      if (retry.current.phase !== "asked") setFailedUrl(url);
      return;
    }
    const src = element.src;
    const attempt: Recovery = {
      element,
      time: "currentTime" in element ? element.currentTime : 0,
      playing: "paused" in element && !element.paused,
      phase: "asked",
    };
    retry.current = attempt;
    const answer = await refetch({ cancelRefetch: false });
    if (answer.error || !element.isConnected || retry.current !== attempt) return;
    attempt.phase = "reloading";
    // React sets a changed src. The Mac can also renew the same address.
    if (answer.data === src && element.src === src) {
      if ("load" in element) element.load();
      else element.src = src;
    }
  }

  function onLoadedMetadata(video: HTMLVideoElement) {
    const attempt = retry.current;
    if (attempt?.element === video) {
      if (attempt.phase !== "reloading") return;
      video.currentTime = attempt.time;
      attempt.phase = "restored";
      if (!attempt.playing) return;
    }
    void video.play().catch(() => {}); // The browser may require a click to play.
  }

  function onProgress(element: Media) {
    const attempt = retry.current;
    if (attempt?.element !== element || attempt.phase === "asked") return;
    // A retry can load metadata and still fail at the same position.
    if (
      !("currentTime" in element) ||
      (attempt.phase === "restored" &&
        element.readyState >= 2 &&
        (element.currentTime !== attempt.time || (!attempt.playing && !element.paused)))
    ) {
      retry.current = null;
    }
  }

  const failed = isError || (url !== undefined && url === failedUrl);
  return { url, failed, onError, onLoadedMetadata, onProgress };
}
