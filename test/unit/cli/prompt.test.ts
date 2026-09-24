import { afterEach, describe, expect, it, vi } from "vitest";
import { input } from "../../../apps/cli/src/prompt";

// `input()` reads `process.stdin` (TTY check, raw mode, `on("data")`) and writes
// render output to `process.stderr`. We swap both for fakes so we can drive
// keystrokes / paste chunks and inspect the resolved value. This is the first
// test coverage for the interactive prompt module.

interface FakeStdin {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  __emit: (buf: Buffer) => void;
  __handler: ((buf: Buffer) => void) | null;
}

function fakeTtyStdin(): FakeStdin {
  const stdin = {
    isTTY: true,
    isRaw: false,
    setRawMode: vi.fn((flag: boolean) => {
      stdin.isRaw = flag;
    }),
    resume: vi.fn(),
    pause: vi.fn(),
    on: vi.fn((_event: string, handler: (buf: Buffer) => void) => {
      stdin.__handler = handler;
    }),
    removeListener: vi.fn(),
    __handler: null as ((buf: Buffer) => void) | null,
  };
  stdin.__emit = (buf: Buffer) => stdin.__handler?.(buf);
  return stdin;
}

function fakeStderr() {
  const writes: string[] = [];
  return {
    write: vi.fn((s: string) => {
      writes.push(s);
      return true;
    }),
    __writes: writes,
  };
}

let origStdinDesc: PropertyDescriptor | undefined;
let origStderrDesc: PropertyDescriptor | undefined;

function installTty(stdin: FakeStdin, stderr: ReturnType<typeof fakeStderr>) {
  origStdinDesc = Object.getOwnPropertyDescriptor(process, "stdin");
  origStderrDesc = Object.getOwnPropertyDescriptor(process, "stderr");
  Object.defineProperty(process, "stdin", { value: stdin, configurable: true, writable: true });
  Object.defineProperty(process, "stderr", { value: stderr, configurable: true, writable: true });
}

function restoreTty() {
  if (origStdinDesc) Object.defineProperty(process, "stdin", origStdinDesc);
  if (origStderrDesc) Object.defineProperty(process, "stderr", origStderrDesc);
}

afterEach(() => {
  restoreTty();
  vi.restoreAllMocks();
});

/**
 * Drive `input()` with a sequence of `data` chunks (each emitted as one
 * `Buffer`, the way a single PTY `write()` lands as one `data` event). A final
 * `"\r"` is emitted to submit unless `submit` is false.
 */
async function runInput(
  chunks: string[],
  opts: { mask?: boolean; submit?: boolean } = {}
): Promise<string> {
  const stdin = fakeTtyStdin();
  installTty(stdin, fakeStderr());
  const pending = input({ message: "Enter:", mask: opts.mask });
  await Promise.resolve();
  for (const chunk of chunks) stdin.__emit(Buffer.from(chunk));
  if (opts.submit !== false) stdin.__emit(Buffer.from("\r"));
  return pending;
}

describe("input() paste hardening — control characters", () => {
  it("strips an embedded newline from a single-chunk paste", async () => {
    // A clipboard whose first line is a valid-looking key followed by a second
    // line of stray text, delivered to the PTY as one data event. Before the
    // fix the \n survived into the masked value and later broke HTTP headers.
    const value = await runInput(["sk-ant-AAAAA\nBBB"], { mask: true });
    expect(value).toBe("sk-ant-AAAAABBB");
    expect(value).not.toContain("\n");
  });

  it("strips multiple embedded control characters of mixed kinds", async () => {
    const value = await runInput(["sk-ant-AA\nBB\rCC\tDD\x00EE\x1bFF"]);
    expect(value).toBe("sk-ant-AABBCCDDEEFF");
    for (const ch of ["\n", "\r", "\t", "\x00", "\x1b"]) {
      expect(value).not.toContain(ch);
    }
  });

  it("no longer drops a chunk that merely begins with a control char", async () => {
    // Before the fix, `\t` at index 0 hit `charCodeAt(0) < 32` and the whole
    // chunk was dropped, yielding "". Now only the control char is stripped.
    const value = await runInput(["\tsk-ant-key"], { mask: true });
    expect(value).toBe("sk-ant-key");
  });

  it("ignores a chunk composed entirely of control characters", async () => {
    const value = await runInput(["\n\r\t"], { mask: true });
    expect(value).toBe("");
  });

  it("leaves a clean paste untouched", async () => {
    const value = await runInput(["sk-ant-cleankey12345"], { mask: true });
    expect(value).toBe("sk-ant-cleankey12345");
  });
});

describe("input() interactive branches", () => {
  it("submits the current value on a single '\\r'", async () => {
    const value = await runInput(["sk-ant-key"], { mask: true });
    expect(value).toBe("sk-ant-key");
  });

  it("removes the last character on backspace (\\x7f)", async () => {
    const value = await runInput(["abc", "\x7f"], { mask: false });
    expect(value).toBe("ab");
  });

  it("throws when stdin is not a TTY", async () => {
    const stdin = fakeTtyStdin();
    stdin.isTTY = false;
    installTty(stdin, fakeStderr());
    await expect(input({ message: "Enter:" })).rejects.toThrow(/TTY/);
  });
});
