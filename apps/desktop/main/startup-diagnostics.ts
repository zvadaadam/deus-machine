import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { app } from "electron";

const MAIN_LOG_FILENAME = "main.log";
const MAX_RECENT_LINES = 120;

let mainLogPath = "";
const recentLines: string[] = [];

export function initMainProcessLogging(): string {
  app.setAppLogsPath();
  const logsDir = app.getPath("logs");
  mkdirSync(logsDir, { recursive: true });
  mainLogPath = join(logsDir, MAIN_LOG_FILENAME);
  return mainLogPath;
}

export function getMainLogPath(): string {
  if (!mainLogPath) {
    initMainProcessLogging();
  }
  return mainLogPath;
}

export function logMainProcess(message: string): void {
  const line = `${new Date().toISOString()} ${message}`;
  recentLines.push(line);
  if (recentLines.length > MAX_RECENT_LINES) {
    recentLines.shift();
  }

  try {
    appendFileSync(getMainLogPath(), `${line}\n`);
  } catch {
    // Never block boot on diagnostics.
  }

  console.error(message);
}

export function getRecentMainProcessLines(maxLines = 12): string {
  return recentLines.slice(-maxLines).join("\n");
}

export function formatStartupFailureDetail(error: unknown): string {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const recentOutput = getRecentMainProcessLines();

  return [
    "The application backend failed to start.",
    "",
    errorMessage,
    "",
    `Log file: ${getMainLogPath()}`,
    recentOutput ? "" : null,
    recentOutput ? "Recent output:" : null,
    recentOutput || null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
