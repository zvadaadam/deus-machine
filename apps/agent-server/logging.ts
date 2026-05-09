// agent-server/logging.ts
// File-backed console logger used by the bundled agent-server process.

import * as fs from "fs";
import * as util from "util";

type LogLevel = "debug" | "info" | "error";

const LOG_LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, error: 2 };
const LOG_FLUSH_DELAY_MS = 100;
const LOG_FLUSH_SIZE_BYTES = 8192;

export interface InstalledLogger {
  logFilePath: string;
  writeStdout: (...args: unknown[]) => void;
  flush: () => void;
}

export function installFileLogger(): InstalledLogger {
  const logFilePath = `/tmp/deus-${process.pid}.log`;
  const originalLog = console.log.bind(console) as (...args: unknown[]) => void;
  const logLevel = parseLogLevel(process.env.LOG_LEVEL);

  let logBuffer = "";
  let flushTimer: NodeJS.Timeout | null = null;

  function shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[logLevel];
  }

  function flush(): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }

    if (!logBuffer) return;
    fs.appendFileSync(logFilePath, logBuffer);
    logBuffer = "";
  }

  function writeLog(line: string): void {
    logBuffer += line;

    if (!flushTimer) {
      flushTimer = setTimeout(flush, LOG_FLUSH_DELAY_MS);
    }

    if (logBuffer.length > LOG_FLUSH_SIZE_BYTES) {
      flush();
    }
  }

  console.log = (...args: unknown[]) => {
    if (!shouldLog("info")) return;
    writeLog(formatLine("info", args));
  };

  console.error = (...args: unknown[]) => {
    const formatted = formatLogArgs(args);
    writeLog(formatLine("error", args));
    process.stderr.write(`${formatted}\n`);
  };

  console.debug = (...args: unknown[]) => {
    if (!shouldLog("debug")) return;
    writeLog(formatLine("debug", args));
  };

  process.on("exit", flush);

  return { logFilePath, writeStdout: originalLog, flush };
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (value === "debug" || value === "error") return value;
  return "info";
}

function formatLine(level: LogLevel, args: unknown[]): string {
  const timestamp = new Date().toISOString();
  const prefix = level === "info" ? "" : `${level.toUpperCase()}: `;
  return `[${timestamp}] ${prefix}${formatLogArgs(args)}\n`;
}

function formatLogArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return `${arg.message}\n${arg.stack || ""}`;
      return util.inspect(arg, { depth: 4, breakLength: Infinity });
    })
    .join(" ");
}
