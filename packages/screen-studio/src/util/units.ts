import { ScreenStudioError } from "../errors.js";

export interface Size {
  width: number;
  height: number;
}

/**
 * Parse a human duration into milliseconds: "1500ms", "30s", "2.5m", "1h".
 * A bare number means seconds, which is what people type for `--max-duration 30`.
 */
export function parseDuration(value: string | number, name = "duration"): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) throw invalid(name, String(value));
    return Math.round(value * 1000);
  }
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|min|h)?\s*$/i.exec(value);
  if (!match) throw invalid(name, value);
  const amount = Number(match[1]);
  const unit = (match[2] ?? "s").toLowerCase();
  const factor = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "h" ? 3_600_000 : 60_000;
  return Math.round(amount * factor);
}

const BYTES_HINT = "Examples: 500MB, 2GiB";

/** Parse "1GiB", "500MB", "250M" or a bare byte count. */
export function parseBytes(value: string | number, name = "size"): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) throw invalid(name, String(value), BYTES_HINT);
    return Math.round(value);
  }
  const match = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|kib|k|mb|mib|m|gb|gib|g)?\s*$/i.exec(value);
  if (!match) throw invalid(name, value, BYTES_HINT);
  const unit = (match[2] ?? "b").toLowerCase();
  const powers: Record<string, number> = {
    b: 1,
    k: 1024,
    kb: 1000,
    kib: 1024,
    m: 1024 ** 2,
    mb: 1000 ** 2,
    mib: 1024 ** 2,
    g: 1024 ** 3,
    gb: 1000 ** 3,
    gib: 1024 ** 3,
  };
  return Math.round(Number(match[1]) * powers[unit]);
}

/** Parse "1920x1080". */
export function parseSize(value: string, name = "size"): Size {
  const match = /^\s*(\d+)\s*[x×]\s*(\d+)\s*$/i.exec(value);
  if (!match) throw invalid(name, value, "Use WIDTHxHEIGHT, e.g. 1920x1080");
  const size = { width: Number(match[1]), height: Number(match[2]) };
  if (size.width < 16 || size.height < 16 || size.width > 7680 || size.height > 7680) {
    throw invalid(name, value, "Each side must be between 16 and 7680 pixels");
  }
  return size;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Round down to an even number, which yuv420p encoders require. */
export function even(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

function invalid(name: string, value: string, hint?: string): ScreenStudioError {
  return new ScreenStudioError("invalid_argument", `Invalid ${name}: "${value}"`, {
    hint: hint ?? `Examples: 1500ms, 30s, 5m`,
  });
}
