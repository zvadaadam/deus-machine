/**
 * Thumbnail extraction — first frame of a video as JPEG.
 * Used to provide a poster image for recording previews.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Extract the first frame from a video file as a JPEG thumbnail.
 *
 * Output: replaces .mp4 with -thumb.jpg
 * e.g. /tmp/recording-rec_a1b2c3.mp4 → /tmp/recording-rec_a1b2c3-thumb.jpg
 *
 * Returns the thumbnail path on success, null on failure.
 */
export async function extractThumbnail(videoPath: string): Promise<string | null> {
  const thumbPath = videoPath.replace(/\.mp4$/, "-thumb.jpg");

  return new Promise((resolve) => {
    const proc = spawn("ffmpeg", ["-y", "-i", videoPath, "-vframes", "1", "-q:v", "3", thumbPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });

    proc.on("error", () => resolve(null));
    proc.on("close", (code) => {
      if (code === 0 && existsSync(thumbPath)) {
        resolve(thumbPath);
      } else {
        resolve(null);
      }
    });
  });
}
