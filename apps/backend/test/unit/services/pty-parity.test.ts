/**
 * A terminal behaves the same on both engines the backend runs on: Node with
 * node-pty (every other backend test, `bun run dev`) and Bun with its own
 * terminal (the packaged app's deus-runtime). This one file runs under both
 * runners, as sqlite-parity.test.ts does:
 *
 *   bun run test:backend   vitest on Node → node-pty
 *   bun run test:bun       bun test       → Bun.spawn({ terminal })
 *
 * It drives terminals only through `openTerminal`, the adapter the service uses.
 */
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { openTerminal } from "../../../src/services/pty.service";

const engine = process.versions.bun ? "Bun terminal" : "node-pty";

function open(command: string, args: string[] = []) {
  let output = "";
  let resolveExit!: (code: number | null) => void;
  const exited = new Promise<number | null>((resolve) => (resolveExit = resolve));
  const terminal = openTerminal({
    command,
    args,
    cols: 80,
    rows: 24,
    cwd: tmpdir(),
    env: { PATH: "/usr/bin:/bin" },
    onData: (bytes) => (output += Buffer.from(bytes).toString()),
    onExit: (code) => resolveExit(code),
  });
  return { terminal, exited, output: () => output };
}

async function until(seen: () => boolean): Promise<void> {
  const end = Date.now() + 5000;
  while (!seen()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe(`terminal parity (${engine})`, () => {
  it("prints a command's output and reports its exit code", async () => {
    // The workspace shell stays open after writing to the terminal.
    const echo = open("/bin/sh", ["-c", "echo parity-echo; sleep 0.1"]);
    expect(await echo.exited).toBe(0);
    await until(() => echo.output().includes("parity-echo"));
    expect(await open("/bin/sh", ["-c", "exit 3"]).exited).toBe(3);
  });

  it("tells the program which terminal it is in", async () => {
    // The environment given here has no TERM; a program still needs one.
    const term = open("/bin/sh", ["-c", "echo term=$TERM; sleep 0.1"]);
    await until(() => term.output().includes("term=xterm-256color"));
  });

  it("carries what is typed to the program and its answer back", async () => {
    const cat = open("/bin/cat");
    cat.terminal.write([...Buffer.from("round-trip\r")]);
    // Once as the terminal echoes the typing, once as cat prints the line.
    await until(() => (cat.output().match(/round-trip/g) ?? []).length >= 2);
    cat.terminal.kill();
    await cat.exited;
  });

  it("tells the program its new size", async () => {
    const stty = open("/bin/sh", ["-c", "sleep 0.5; stty size"]);
    stty.terminal.resize(100, 30);
    await stty.exited;
    await until(() => stty.output().includes("30 100"));
  });

  it("ends an interactive shell when killed", async () => {
    const shell = open("/bin/sh", ["-i"]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    shell.terminal.kill();
    await shell.exited;
  });
});
