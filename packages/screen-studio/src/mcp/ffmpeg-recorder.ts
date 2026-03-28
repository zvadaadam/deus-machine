import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { platform } from "node:os";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import type { FfmpegCaptureConfig, FfmpegPostProcessConfig } from "./types.js";

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
 * Check if a specific ffmpeg filter is available.
 * Returns true if the filter exists in this ffmpeg build.
 */
export async function hasFilter(filterName: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("ffmpeg", ["-filters"], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    proc.on("error", () => resolve(false));
    proc.on("close", () => {
      // ffmpeg -filters output: " T.. drawtext  V->V  Draw text..."
      resolve(output.includes(` ${filterName} `) || output.includes(` ${filterName}\t`));
    });
  });
}

/**
 * Detect the current platform's preferred capture method.
 * Returns "x11grab" on Linux, "avfoundation" on macOS.
 */
export function detectCaptureMethod(): "x11grab" | "avfoundation" {
  return platform() === "darwin" ? "avfoundation" : "x11grab";
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
    const output = execFileSync("ffmpeg", ["-f", "avfoundation", "-list_devices", "true", "-i", ""], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
    });
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
      "-f", "x11grab",
      "-video_size", `${config.sourceSize.width}x${config.sourceSize.height}`,
      "-framerate", String(config.fps),
      "-i", config.display,
    );
  } else {
    // avfoundation (macOS)
    // Auto-detect screen device index, fallback to config.display or "1"
    const screenDevice = config.screenDevice ?? detectScreenDevice() ?? "1";

    args.push(
      "-f", "avfoundation",
      "-framerate", String(config.fps),
      "-capture_cursor", "1",
      // "N:none" = video device N, no audio
      "-i", `${screenDevice}:none`,
    );
  }

  args.push(
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-crf", "18",
    config.outputPath,
  );

  return args;
}

/**
 * Escape text for use in ffmpeg's drawtext filter.
 *
 * ffmpeg drawtext interprets several characters as special:
 * - Backslash: escape character (needs quadruple escaping for shell + ffmpeg)
 * - Single quote: text delimiter
 * - Colon: drawtext option separator
 * - Percent: ffmpeg expression variable
 * - Semicolon: filter graph separator
 * - Brackets: stream specifier syntax
 * - Equals: option key=value separator
 * - Newlines: not supported in drawtext, dropped
 */
export function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, "\\\\\\\\")  // Backslash (needs quadruple for shell + ffmpeg)
    .replace(/'/g, "'\\\\''")     // Single quote
    .replace(/:/g, "\\\\:")       // Colon (drawtext separator)
    .replace(/%/g, "%%")          // Percent (ffmpeg expression)
    .replace(/;/g, "\\\\;")      // Semicolon (filter separator)
    .replace(/\[/g, "\\\\[")     // Open bracket (stream specifier)
    .replace(/\]/g, "\\\\]")     // Close bracket (stream specifier)
    .replace(/=/g, "\\\\=")      // Equals (option separator)
    .replace(/\n/g, "");          // Newlines (drop them)
}

/**
 * Build ffmpeg args for post-processing (compositing the zoompan filter).
 *
 * ffmpeg -i raw.mp4 -filter_complex "[zoompan filter]" -c:v libx264 -preset slow -crf 22 output.mp4
 *
 * If addWatermark is true but drawtext filter is unavailable, the watermark
 * is silently skipped (no error).
 */
export function buildPostProcessArgs(config: FfmpegPostProcessConfig): string[] {
  const args: string[] = ["-y", "-i", config.inputPath];

  let filterComplex = config.filterComplex;

  // Add watermark overlay if requested AND drawtext is available
  if (config.addWatermark && config.watermarkText && config.hasDrawtext) {
    const escapedText = escapeDrawtext(config.watermarkText);
    const watermarkFilter = `,drawtext=text='${escapedText}':fontsize=24:fontcolor=white@0.5:x=w-tw-20:y=h-th-20`;
    filterComplex += watermarkFilter;
  }

  args.push("-filter_complex", filterComplex);

  args.push(
    "-c:v", "libx264",
    "-preset", "slow",
    "-crf", "22",
    "-s", `${config.outputSize.width}x${config.outputSize.height}`,
    config.outputPath,
  );

  return args;
}

/**
 * Manages ffmpeg child processes for screen capture and post-processing.
 *
 * Lifecycle:
 * 1. startCapture() — spawns ffmpeg to record the screen
 * 2. stopCapture() — sends 'q' to ffmpeg stdin to stop gracefully
 * 3. postProcess() — runs zoompan + compositing filter on the raw capture
 * 4. cleanup() — removes temp files
 */
export class FfmpegRecorder {
  private captureProcess: ChildProcess | null = null;
  private rawCapturePath: string | null = null;
  private captureStderr = "";

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
            reject(new Error(
              `ffmpeg capture failed to start within 2s.\n` +
              `Last stderr: ${this.captureStderr.slice(-300)}\n` +
              `Hint: On macOS, ensure Screen Recording permission is granted in System Settings → Privacy & Security.`,
            ));
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

      proc.on("close", (code) => {
        clearTimeout(startupTimer);
        this.captureProcess = null;
        if (!resolved) {
          resolved = true;
          if (code !== 0 && code !== 255) {
            reject(new Error(
              `ffmpeg capture exited immediately with code ${code}.\n` +
              `stderr: ${this.captureStderr.slice(-500)}\n` +
              `Hint: Check that the capture device is accessible. On macOS, run 'ffmpeg -f avfoundation -list_devices true -i ""' to see available devices.`,
            ));
          }
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
    if (!this.captureProcess) return this.rawCapturePath;

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
        `Hint: On macOS, ensure Screen Recording permission is granted. On Linux, ensure Xvfb is running on the configured display.`,
      );
    }

    return path;
  }

  /**
   * Run post-processing on a raw capture file.
   * Applies the zoompan filter + optional watermark.
   *
   * Verifies the input file exists before starting.
   * If watermark is requested, checks if drawtext filter is available
   * and silently skips it if not.
   */
  async postProcess(config: FfmpegPostProcessConfig): Promise<string> {
    // Verify input exists
    if (!existsSync(config.inputPath)) {
      throw new Error(
        `Cannot post-process: raw capture file not found at ${config.inputPath}.\n` +
        `Hint: The screen capture may have failed. Check capture permissions and device availability.`,
      );
    }

    // Check if drawtext is available when watermark is requested
    let effectiveConfig = config;
    if (config.addWatermark && config.watermarkText) {
      const drawtext = await hasFilter("drawtext");
      effectiveConfig = { ...config, hasDrawtext: drawtext };
      if (!drawtext) {
        // Log warning to stderr (not stdout — agent reads stdout)
        process.stderr?.write?.(
          `[screen-studio] Warning: drawtext filter not available in this ffmpeg build. ` +
          `Watermark skipped. Install ffmpeg with --enable-libfreetype for watermark support.\n`,
        );
      }
    }

    const args = buildPostProcessArgs(effectiveConfig);

    return new Promise<string>((resolve, reject) => {
      const proc = spawn("ffmpeg", args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stderr = "";
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on("error", (err) => {
        reject(new Error(`Failed to start ffmpeg post-processing: ${err.message}`));
      });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve(config.outputPath);
        } else {
          reject(new Error(
            `ffmpeg post-processing exited with code ${code}.\n` +
            `stderr: ${stderr.slice(-500)}\n` +
            `Hint: Check the filter syntax and input file format.`,
          ));
        }
      });
    });
  }

  /**
   * Check if a capture is currently running.
   */
  isCapturing(): boolean {
    return this.captureProcess !== null;
  }

  /**
   * Get the last stderr output from the capture process.
   * Useful for diagnostics when capture fails.
   */
  getLastStderr(): string {
    return this.captureStderr;
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
    }
  }
}
