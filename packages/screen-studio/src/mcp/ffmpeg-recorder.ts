import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { platform } from "node:os";
import { existsSync } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import type { FfmpegCaptureConfig } from "./types.js";

/**
 * Probe a video file's actual dimensions using ffprobe.
 * Returns { width, height } or null if ffprobe fails or file doesn't exist.
 *
 * This is the only reliable way to know what ffmpeg will actually decode,
 * since stream metadata (deviceWidth/deviceHeight) may differ from actual
 * JPEG pixel dimensions (e.g., retina scaling, scrollbar offsets).
 */
export async function probeVideoDimensions(
  filePath: string
): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const proc = spawn(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "csv=p=0",
        filePath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    let output = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    proc.on("error", () => resolve(null));
    proc.on("close", (code) => {
      if (code !== 0) return resolve(null);
      // Output format: "width,height\n" e.g. "1280,720\n"
      const parts = output.trim().split(",");
      if (parts.length >= 2) {
        const width = parseInt(parts[0], 10);
        const height = parseInt(parts[1], 10);
        if (width > 0 && height > 0) {
          return resolve({ width, height });
        }
      }
      resolve(null);
    });
  });
}

/**
 * Check if ffmpeg is available on the system PATH.
 * Returns the version string if found, null otherwise.
 */
export async function detectFfmpeg(): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn("ffmpeg", ["-version"], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    proc.on("error", () => resolve(null));
    proc.on("close", (code) => {
      if (code === 0 && output.length > 0) {
        const match = output.match(/ffmpeg version (\S+)/);
        resolve(match ? match[1] : "unknown");
      } else {
        resolve(null);
      }
    });
  });
}

/**
 * Auto-detect the screen capture device index for avfoundation on macOS.
 *
 * Runs `ffmpeg -f avfoundation -list_devices true -i ""` and parses
 * the output to find the first "Capture screen N" device.
 *
 * Returns the device index string (e.g. "4") or null if not found.
 */
export function detectScreenDevice(): string | null {
  if (platform() !== "darwin") return null;

  try {
    // ffmpeg -list_devices writes to stderr and exits with code 1 (expected)
    const output = execFileSync(
      "ffmpeg",
      ["-f", "avfoundation", "-list_devices", "true", "-i", ""],
      {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 5000,
      }
    );
    return parseScreenDevice(output);
  } catch (err: unknown) {
    // ffmpeg writes device list to stderr and exits 1 — that's normal
    const stderr = (err as { stderr?: string })?.stderr ?? "";
    return parseScreenDevice(stderr);
  }
}

/**
 * Parse avfoundation device list output to find the screen capture device.
 * Looks for lines like: [AVFoundation ...] [4] Capture screen 0
 */
function parseScreenDevice(output: string): string | null {
  const lines = output.split("\n");
  for (const line of lines) {
    // Match: [AVFoundation ...] [N] Capture screen M
    const match = line.match(/\[(\d+)]\s+Capture screen/);
    if (match) {
      return match[1];
    }
  }
  return null;
}

/**
 * Build ffmpeg args for screen capture.
 *
 * Linux (x11grab):
 *   ffmpeg -f x11grab -video_size WxH -framerate FPS -i :99 -c:v libx264 ...
 *
 * macOS (avfoundation):
 *   ffmpeg -f avfoundation -framerate FPS -capture_cursor 1 -i "N:none" ...
 *   where N is the auto-detected screen device index.
 */
export function buildCaptureArgs(config: FfmpegCaptureConfig): string[] {
  const args: string[] = ["-y"]; // overwrite output

  if (config.method === "x11grab") {
    args.push(
      "-f",
      "x11grab",
      "-video_size",
      `${config.sourceSize.width}x${config.sourceSize.height}`,
      "-framerate",
      String(config.fps),
      "-i",
      config.display
    );
  } else {
    // avfoundation (macOS)
    // Auto-detect screen device index, fallback to config.display or "1"
    const screenDevice = config.screenDevice ?? detectScreenDevice() ?? "1";

    args.push(
      "-f",
      "avfoundation",
      "-framerate",
      String(config.fps),
      "-capture_cursor",
      "1",
      // "N:none" = video device N, no audio
      "-i",
      `${screenDevice}:none`
    );
  }

  args.push("-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", config.outputPath);

  return args;
}

/**
 * Manages ffmpeg child processes for screen capture.
 *
 * Lifecycle:
 * 1. startCapture() — spawns ffmpeg to record the screen
 * 2. stopCapture() — sends 'q' to ffmpeg stdin to stop gracefully
 * 3. cleanup() — removes temp files
 */
export class FfmpegRecorder {
  private captureProcess: ChildProcess | null = null;
  private rawCapturePath: string | null = null;
  private captureStderr = "";
  private captureExitError: string | null = null;

  /**
   * Start screen capture.
   * Spawns ffmpeg as a child process.
   *
   * On macOS, auto-detects the screen capture device. On Linux, uses the
   * display from config (default ":99" for Xvfb).
   *
   * Waits up to 2s for ffmpeg to start writing frames. If ffmpeg exits
   * during startup, throws with the ffmpeg error.
   */
  async startCapture(config: FfmpegCaptureConfig): Promise<void> {
    if (this.captureProcess) {
      throw new Error("ffmpeg capture is already running");
    }

    const args = buildCaptureArgs(config);
    this.rawCapturePath = config.outputPath;
    this.captureStderr = "";

    return new Promise<void>((resolve, reject) => {
      const proc = spawn("ffmpeg", args, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.captureProcess = proc;
      let resolved = false;

      proc.stderr?.on("data", (chunk: Buffer) => {
        this.captureStderr += chunk.toString();

        // ffmpeg writes "frame= N" when it starts actually capturing
        if (!resolved && this.captureStderr.includes("frame=")) {
          resolved = true;
          resolve();
        }
      });

      // Fallback: if no "frame=" after 2s, check if process is still alive
      const startupTimer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          if (this.captureProcess) {
            // Process is still running — likely capturing (some ffmpeg builds
            // don't write "frame=" immediately)
            resolve();
          } else {
            reject(
              new Error(
                `ffmpeg capture failed to start within 2s.\n` +
                  `Last stderr: ${this.captureStderr.slice(-300)}\n` +
                  `Hint: On macOS, ensure Screen Recording permission is granted in System Settings → Privacy & Security.`
              )
            );
          }
        }
      }, 2000);

      proc.on("error", (err) => {
        clearTimeout(startupTimer);
        this.captureProcess = null;
        if (!resolved) {
          resolved = true;
          reject(new Error(`Failed to start ffmpeg: ${err.message}`));
        }
      });

      proc.on("close", (code, signal) => {
        clearTimeout(startupTimer);
        this.captureProcess = null;
        if (!resolved) {
          resolved = true;
          reject(
            new Error(
              `ffmpeg capture exited before startup completed (code ${code ?? "null"}, signal ${signal ?? "none"}).\n` +
                `stderr: ${this.captureStderr.slice(-500)}\n` +
                `Hint: Check that the capture device is accessible.`
            )
          );
        } else if (code !== 0) {
          // After startup resolved, capture unexpected exit
          this.captureExitError = `ffmpeg capture exited unexpectedly (code ${code ?? "null"}).\nstderr: ${this.captureStderr.slice(-300)}`;
        }
      });
    });
  }

  /**
   * Stop the active capture process.
   * Sends 'q' to ffmpeg stdin for graceful shutdown.
   * Returns the raw capture path, or null if capture wasn't running.
   *
   * After stopping, verifies the raw file exists and has content.
   * Throws if the raw file is missing or empty.
   */
  async stopCapture(): Promise<string | null> {
    if (!this.captureProcess) {
      // Check if capture died while we weren't looking
      if (this.captureExitError) {
        const err = this.captureExitError;
        this.captureExitError = null;
        throw new Error(`Capture failed during recording: ${err}`);
      }
      return this.rawCapturePath;
    }

    const path = await new Promise<string | null>((resolve) => {
      const proc = this.captureProcess!;

      const killTimer = setTimeout(() => {
        proc.kill("SIGKILL");
      }, 10_000);

      proc.on("close", () => {
        clearTimeout(killTimer);
        this.captureProcess = null;
        resolve(this.rawCapturePath);
      });

      if (proc.stdin?.writable) {
        proc.stdin.write("q");
        proc.stdin.end();
      } else {
        proc.kill("SIGINT");
      }
    });

    // Verify the raw file actually exists
    if (path && !existsSync(path)) {
      throw new Error(
        `Screen capture failed: raw file not found at ${path}.\n` +
          `ffmpeg stderr: ${this.captureStderr.slice(-300)}\n` +
          `Hint: On macOS, ensure Screen Recording permission is granted. On Linux, ensure Xvfb is running on the configured display.`
      );
    }

    // Verify the raw file is not empty (e.g. permission denied produces 0-byte file)
    if (path) {
      const { size } = await stat(path);
      if (size === 0) {
        throw new Error(
          `Screen capture failed: raw file at ${path} is empty.\n` +
            `ffmpeg stderr: ${this.captureStderr.slice(-300)}\n` +
            `Hint: On macOS, ensure Screen Recording permission is granted.`
        );
      }
    }

    return path;
  }

  /**
   * Check if a capture is currently running.
   */
  isCapturing(): boolean {
    return this.captureProcess !== null;
  }

  /**
   * Clean up temporary capture file.
   */
  async cleanup(): Promise<void> {
    if (this.rawCapturePath && existsSync(this.rawCapturePath)) {
      try {
        await unlink(this.rawCapturePath);
      } catch {
        // Ignore cleanup errors
      }
    }
    this.rawCapturePath = null;
  }

  /**
   * Force-kill the capture process if running.
   */
  kill(): void {
    if (this.captureProcess) {
      this.captureProcess.kill("SIGKILL");
      this.captureProcess = null;
      this.captureExitError = null;
    }
  }
}
