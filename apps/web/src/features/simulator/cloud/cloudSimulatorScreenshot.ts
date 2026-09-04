import type { CloudSimPlatform } from "./cloudSimulatorStore";

/**
 * Which capture answers a Screenshot click.
 *
 * The PNG rides a `cloud:simulator` screenshot EVENT, fanned out to every
 * viewer — the agent's own captures included — and the exec that asked for it
 * is answered just after the platform emitted it. Both the capture and the
 * answer are stamped by the PLATFORM's clock, so the requested capture is the
 * one stamped moments before the answer; the agent's older capture delivered
 * late does not qualify, whatever order the two arrive in. This clock never
 * meets the platform's: our own time only orders arrivals when the platform
 * stamped nothing.
 */

/** The platform's ISO stamp as epoch ms; null when absent or unparseable. */
export function parsePlatformTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

/** How long before its answer the platform may have taken the capture the
 *  answer is about (the device verb runs, the PNG is encoded and emitted,
 *  then the exec is answered). */
export const CAPTURE_BEFORE_ANSWER_MS = 30_000;
/** The capture is emitted before the answer; a stamp later than the answer
 *  is another capture — with a little room for the two stamps' resolution. */
export const CAPTURE_AFTER_ANSWER_MS = 2_000;

export interface ScreenshotAsk {
  /** This clock when the button was pressed. */
  askedAt: number;
  /** The displayed device's platform when asked. */
  platform: CloudSimPlatform | null;
  /** Whether the platform has answered the exec that asked. */
  answered: boolean;
  /** The platform's clock on that answer; null when it stamped none. */
  respondedAt: number | null;
}

export interface ScreenshotCapture {
  /** This clock when the capture arrived. */
  at: number;
  /** The platform's clock when it took the capture; null when unstamped. */
  capturedAt: number | null;
  platform: CloudSimPlatform | null;
}

export function captureAnswersAsk(ask: ScreenshotAsk, capture: ScreenshotCapture): boolean {
  // Another platform's capture: not ours — keep waiting for the right one.
  if (ask.platform && capture.platform && capture.platform !== ask.platform) return false;
  // The platform's capture precedes its answer: until the answer is in,
  // whatever arrived is at best unproven.
  if (!ask.answered) return false;
  // One side unstamped by the platform: arrival order is all there is.
  if (ask.respondedAt === null || capture.capturedAt === null) return capture.at >= ask.askedAt;
  return (
    capture.capturedAt >= ask.respondedAt - CAPTURE_BEFORE_ANSWER_MS &&
    capture.capturedAt <= ask.respondedAt + CAPTURE_AFTER_ANSWER_MS
  );
}
