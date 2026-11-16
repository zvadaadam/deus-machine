import { spawn } from "node:child_process";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { STOP_ON_STDIN_END_ENV, stopWhenStdinEnds } from "../../../src/lib/parent-stdin";

describe("stopWhenStdinEnds", () => {
  it("does nothing unless the desktop set the flag", () => {
    for (const env of [{}, { [STOP_ON_STDIN_END_ENV]: "0" }, { [STOP_ON_STDIN_END_ENV]: "" }]) {
      const stdin = new PassThrough();
      const stop = vi.fn();
      expect(stopWhenStdinEnds(stop, env, stdin)).toBe(false);
      expect(stdin.listenerCount("end")).toBe(0);
      expect(stdin.listenerCount("data")).toBe(0);
      stdin.end();
      expect(stop).not.toHaveBeenCalled();
    }
  });

  it("stops once when stdin ends, and keeps the flag from what the backend starts", async () => {
    const env: NodeJS.ProcessEnv = { [STOP_ON_STDIN_END_ENV]: "1", PATH: "/usr/bin" };
    const stdin = new PassThrough();
    const stop = vi.fn();
    expect(stopWhenStdinEnds(stop, env, stdin)).toBe(true);
    expect(env).toEqual({ PATH: "/usr/bin" });

    stdin.write("ignored");
    await new Promise((resolve) => setImmediate(resolve));
    expect(stop).not.toHaveBeenCalled();

    stdin.end();
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
    stdin.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    expect(stop).toHaveBeenCalledOnce();
  });

  it("stops a real process whose parent's end of the pipe closes", async () => {
    const module = path.resolve(__dirname, "../../../src/lib/parent-stdin.ts");
    const script = `
      const { stopWhenStdinEnds } = await import(${JSON.stringify(module)});
      stopWhenStdinEnds(() => { console.log("stopping"); process.exit(0); });
      console.log("watching");
    `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx/esm", "--input-type=module", "-e", script],
      {
        env: { ...process.env, [STOP_ON_STDIN_END_ENV]: "1" },
        stdio: ["pipe", "pipe", "inherit"],
      }
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    await vi.waitFor(() => expect(output).toContain("watching"), { timeout: 8_000 });

    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
    child.stdin.end(); // as when the desktop exits, by any means
    expect(await exited).toBe(0);
    expect(output).toContain("stopping");
  });
});
