import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(__dirname, "../src/cli/index.ts");
const STATE_DIR = join(tmpdir(), "screen-studio");
const STATE_FILE = join(STATE_DIR, "sessions.json");

function run(...args: string[]): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync("bunx", ["tsx", CLI, ...args], {
      encoding: "utf-8",
      timeout: 10_000,
      env: { ...process.env },
    });
    return { stdout: stdout.trim(), stderr: "", exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: (err.stdout ?? "").trim(),
      stderr: (err.stderr ?? "").trim(),
      exitCode: err.status ?? 1,
    };
  }
}

function parseOutput(result: { stdout: string; stderr: string }): Record<string, unknown> {
  // stdout for success, stderr for errors
  const text = result.stdout || result.stderr;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

describe("screen-studio CLI", () => {
  beforeEach(() => {
    // Clean state between tests
    if (existsSync(STATE_FILE)) {
      rmSync(STATE_FILE);
    }
  });

  afterEach(() => {
    if (existsSync(STATE_FILE)) {
      rmSync(STATE_FILE);
    }
  });

  describe("help", () => {
    it("shows help with --help", () => {
      const result = run("--help");
      expect(result.stdout).toContain("screen-studio");
      expect(result.stdout).toContain("Commands:");
      expect(result.stdout).toContain("start");
      expect(result.stdout).toContain("event");
      expect(result.stdout).toContain("stop");
      expect(result.exitCode).toBe(0);
    });

    it("shows help with no args", () => {
      const result = run("help");
      expect(result.stdout).toContain("Commands:");
      expect(result.exitCode).toBe(0);
    });
  });

  describe("version", () => {
    it("shows version", () => {
      const result = run("version");
      const data = parseOutput(result);
      expect(data.version).toBe("0.1.0");
    });
  });

  describe("start", () => {
    it("creates a session and returns JSON", () => {
      const result = run("start");
      expect(result.exitCode).toBe(0);

      const data = parseOutput(result);
      expect(data.session_id).toBeDefined();
      expect(typeof data.session_id).toBe("string");
      expect((data.session_id as string).startsWith("rec_")).toBe(true);
      expect(data.status).toBe("recording");
      expect(data.output_path).toBeDefined();
    });

    it("accepts --output flag", () => {
      const outPath = join(tmpdir(), "test-recording.mp4");
      const result = run("start", "--output", outPath);
      const data = parseOutput(result);
      expect(data.output_path).toBe(outPath);
    });
  });

  describe("event", () => {
    it("records a click event", () => {
      // Start a session first
      const startResult = run("start");
      const startData = parseOutput(startResult);
      const sessionId = startData.session_id as string;

      // Record an event
      const result = run("event", sessionId, "--type", "click", "--x", "500", "--y", "300");
      expect(result.exitCode).toBe(0);

      const data = parseOutput(result);
      expect(data.recorded).toBe(true);
      expect(data.event_index).toBe(0);
      expect(data.timestamp_ms).toBeDefined();
    });

    it("records a type event with --text", () => {
      const startData = parseOutput(run("start"));
      const sessionId = startData.session_id as string;

      const result = run("event", sessionId, "--type", "type", "--x", "500", "--y", "320", "--text", "hello world");
      const data = parseOutput(result);
      expect(data.recorded).toBe(true);
    });

    it("records multiple events with incrementing index", () => {
      const startData = parseOutput(run("start"));
      const sessionId = startData.session_id as string;

      const r1 = parseOutput(run("event", sessionId, "--type", "click", "--x", "100", "--y", "100"));
      const r2 = parseOutput(run("event", sessionId, "--type", "click", "--x", "200", "--y", "200"));
      const r3 = parseOutput(run("event", sessionId, "--type", "click", "--x", "300", "--y", "300"));

      expect(r1.event_index).toBe(0);
      expect(r2.event_index).toBe(1);
      expect(r3.event_index).toBe(2);
    });

    it("fails with missing session ID", () => {
      const result = run("event");
      expect(result.exitCode).toBe(1);
      const data = parseOutput(result);
      expect(data.error).toContain("Missing session ID");
    });

    it("fails with invalid session ID", () => {
      const result = run("event", "rec_nonexistent", "--type", "click", "--x", "0", "--y", "0");
      expect(result.exitCode).toBe(1);
      const data = parseOutput(result);
      expect(data.error).toContain("Session not found");
    });

    it("fails with missing --type flag", () => {
      const startData = parseOutput(run("start"));
      const sessionId = startData.session_id as string;

      const result = run("event", sessionId, "--x", "500", "--y", "300");
      expect(result.exitCode).toBe(1);
      const data = parseOutput(result);
      expect(data.error).toContain("Missing required flag --type");
    });

    it("fails with invalid event type", () => {
      const startData = parseOutput(run("start"));
      const sessionId = startData.session_id as string;

      const result = run("event", sessionId, "--type", "explode", "--x", "0", "--y", "0");
      expect(result.exitCode).toBe(1);
      const data = parseOutput(result);
      expect(data.error).toContain("Invalid event type");
      expect(data.hint).toContain("click");
    });
  });

  describe("chapter", () => {
    it("adds a chapter marker", () => {
      const startData = parseOutput(run("start"));
      const sessionId = startData.session_id as string;

      const result = run("chapter", sessionId, "--title", "Introduction");
      expect(result.exitCode).toBe(0);

      const data = parseOutput(result);
      expect(data.chapter_index).toBe(0);
      expect(data.title).toBe("Introduction");
      expect(data.timestamp_ms).toBeDefined();
    });

    it("fails with missing --title", () => {
      const startData = parseOutput(run("start"));
      const sessionId = startData.session_id as string;

      const result = run("chapter", sessionId);
      expect(result.exitCode).toBe(1);
      const data = parseOutput(result);
      expect(data.error).toContain("Missing required flag --title");
    });
  });

  describe("status", () => {
    it("returns session status", () => {
      const startData = parseOutput(run("start"));
      const sessionId = startData.session_id as string;

      // Add some events
      run("event", sessionId, "--type", "click", "--x", "500", "--y", "300");
      run("event", sessionId, "--type", "type", "--x", "500", "--y", "320", "--text", "test");
      run("chapter", sessionId, "--title", "Test");

      const result = run("status", sessionId);
      expect(result.exitCode).toBe(0);

      const data = parseOutput(result);
      expect(data.session_id).toBe(sessionId);
      expect(data.status).toBe("recording");
      expect(data.event_count).toBe(2);
      expect(data.chapter_count).toBe(1);
      expect(typeof data.duration_s).toBe("number");
    });
  });

  describe("list", () => {
    it("lists no sessions when empty", () => {
      const result = run("list");
      const data = parseOutput(result);
      expect(data.count).toBe(0);
      expect((data.sessions as unknown[]).length).toBe(0);
    });

    it("lists active sessions", () => {
      run("start");
      run("start");

      const result = run("list");
      const data = parseOutput(result);
      expect(data.count).toBe(2);
    });
  });

  describe("stop", () => {
    it("stops a session with events-only mode", () => {
      const startData = parseOutput(run("start"));
      const sessionId = startData.session_id as string;

      // Add events
      run("event", sessionId, "--type", "click", "--x", "500", "--y", "300");
      run("event", sessionId, "--type", "type", "--x", "500", "--y", "320", "--text", "hello");

      const result = run("stop", sessionId);
      expect(result.exitCode).toBe(0);

      const data = parseOutput(result);
      expect(data.session_id).toBe(sessionId);
      expect(data.status).toBe("done");
      expect(data.event_count).toBe(2);
    });

    it("fails when session is already stopped", () => {
      const startData = parseOutput(run("start"));
      const sessionId = startData.session_id as string;

      run("stop", sessionId);

      const result = run("stop", sessionId);
      expect(result.exitCode).toBe(1);
      const data = parseOutput(result);
      expect(data.error).toContain("not recording");
    });
  });

  describe("unknown command", () => {
    it("shows error with hint", () => {
      const result = run("deploy");
      expect(result.exitCode).toBe(1);
      const data = parseOutput(result);
      expect(data.error).toContain("Unknown command");
      expect(data.hint).toContain("start");
    });
  });
});
