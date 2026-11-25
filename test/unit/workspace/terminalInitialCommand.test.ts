import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@shared/api";
import {
  clearTerminalInitialCommand,
  consumeTerminalInitialCommand,
  getTerminalInitialCommand,
  setTerminalInitialCommand,
} from "@/features/terminal/store/terminalTaskStore";

const { effects, refs, onDataCallbacks, callMock, followMock } = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  refs: { index: 0, list: [] as Array<{ current: unknown }> },
  onDataCallbacks: [] as Array<(data: string) => void>,
  callMock: vi.fn(),
  followMock: vi.fn(() => () => {}),
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (initial: unknown) => [initial, vi.fn()],
  useRef: (initial: unknown) => {
    const idx = refs.index++;
    if (!refs.list[idx]) refs.list[idx] = { current: initial };
    return refs.list[idx];
  },
  useEffect: (fn: () => void | (() => void)) => {
    effects.push(fn);
  },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class MockXTerm {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    loadAddon = vi.fn();
    open = vi.fn();
    write = vi.fn();
    clear = vi.fn();
    dispose = vi.fn();
    onData = (cb: (data: string) => void) => {
      onDataCallbacks.push(cb);
      return { dispose: vi.fn() };
    };
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    fit = vi.fn();
  },
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class MockWebLinksAddon {},
}));

vi.mock("@/platform/ws", () => ({
  call: callMock,
  follow: followMock,
}));

import { Terminal } from "@/features/terminal/ui/Terminal";

function mountTerminal(id: string) {
  effects.length = 0;
  refs.index = 0;
  refs.list.length = 0;
  onDataCallbacks.length = 0;

  // Populate terminalRef (first useRef) with a mock container element before effect runs.
  refs.list[0] = { current: { offsetWidth: 800, offsetHeight: 400 } };

  Terminal({
    id,
    workspacePath: "/repo",
    consumeInitialCommand: consumeTerminalInitialCommand,
    visible: true,
  });

  // Effect[1] is the PTY lifecycle effect in Terminal.tsx.
  const cleanup = effects[1]?.();
  return () => {
    if (typeof cleanup === "function") cleanup();
  };
}

function decodeWrites(): string[] {
  return callMock.mock.calls
    .filter(([op]) => op === api.ptyWrite)
    .map(([, payload]) => new TextDecoder().decode(new Uint8Array(payload.data)));
}

describe("Terminal one-shot initial command dispatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    callMock.mockReset();
    followMock.mockClear();
    vi.stubGlobal("document", {
      documentElement: { classList: { contains: () => false } },
      createElement: () => ({ getContext: () => null }),
    });
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
    vi.stubGlobal(
      "ResizeObserver",
      class MockResizeObserver {
        observe = vi.fn();
        disconnect = vi.fn();
      }
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    clearTerminalInitialCommand("term-remount");
    clearTerminalInitialCommand("term-retry");
    clearTerminalInitialCommand("term-strict");
    clearTerminalInitialCommand("term-early-exit");
  });

  it("dispatches an env task command once and does not re-run it after host remount (e.g. returning from Home)", async () => {
    callMock.mockResolvedValue({});
    setTerminalInitialCommand("term-remount", "bun run dev");

    const unmountFirst = mountTerminal("term-remount");
    await vi.advanceTimersByTimeAsync(300);

    expect(decodeWrites()).toEqual(["bun run dev\n"]);
    expect(getTerminalInitialCommand("term-remount")).toBeUndefined();

    // Simulate navigating to Home (unmounting TerminalHost) and returning (remounting Terminal).
    unmountFirst();
    const unmountSecond = mountTerminal("term-remount");
    await vi.advanceTimersByTimeAsync(500);

    expect(decodeWrites()).toEqual(["bun run dev\n"]);
    unmountSecond();
  });

  it("preserves the command across a pre-dispatch ptySpawn failure and runs it once on Enter retry", async () => {
    let spawnAttempt = 0;
    callMock.mockImplementation((op) => {
      if (op === api.ptySpawn) {
        spawnAttempt += 1;
        if (spawnAttempt === 1) return Promise.reject(new Error("spawn failed"));
      }
      return Promise.resolve({});
    });

    setTerminalInitialCommand("term-retry", "bun run test");

    const unmount = mountTerminal("term-retry");
    await vi.advanceTimersByTimeAsync(350);

    // First spawn failed before dispatch: command must still be queued, no ptyWrite yet.
    expect(decodeWrites()).toEqual([]);
    expect(getTerminalInitialCommand("term-retry")).toBe("bun run test");

    // User presses Enter to respawn the PTY.
    onDataCallbacks[0]?.("\r");
    await vi.advanceTimersByTimeAsync(300);

    expect(decodeWrites()).toEqual(["bun run test\n"]);
    expect(getTerminalInitialCommand("term-retry")).toBeUndefined();
    unmount();
  });

  it("preserves the command if unmounted before the post-spawn settle timer fires", async () => {
    callMock.mockResolvedValue({});
    setTerminalInitialCommand("term-strict", "bun run lint");

    const unmountFirst = mountTerminal("term-strict");
    await vi.advanceTimersByTimeAsync(100);
    unmountFirst();

    // Unmounted before 300ms settle timer — command was not consumed yet.
    expect(decodeWrites()).toEqual([]);
    expect(getTerminalInitialCommand("term-strict")).toBe("bun run lint");

    const unmountSecond = mountTerminal("term-strict");
    await vi.advanceTimersByTimeAsync(300);

    expect(decodeWrites()).toEqual(["bun run lint\n"]);
    expect(getTerminalInitialCommand("term-strict")).toBeUndefined();
    unmountSecond();
  });

  it("preserves the command when the PTY exits after ptySpawn ack before dispatch, and runs it on Enter retry", async () => {
    callMock.mockResolvedValue({});
    const outputHandlers: Array<(event: { type: string; error?: string }) => void> = [];
    followMock.mockImplementation((_stream, _filter, cb) => {
      outputHandlers.push(cb);
      return () => {};
    });

    setTerminalInitialCommand("term-early-exit", "bun run check");

    const unmount = mountTerminal("term-early-exit");
    // Let ptySpawn resolve, then shell dies at 100ms before the 300ms settle timer fires.
    await vi.advanceTimersByTimeAsync(100);
    outputHandlers[0]?.({ type: "exit", error: "shell exited unexpectedly" });
    await vi.advanceTimersByTimeAsync(300);

    // Dead shell must NOT consume or write the initial command.
    expect(decodeWrites()).toEqual([]);
    expect(getTerminalInitialCommand("term-early-exit")).toBe("bun run check");

    // User presses Enter to restart the shell; command runs once on the restarted PTY.
    onDataCallbacks[0]?.("\r");
    await vi.advanceTimersByTimeAsync(300);

    expect(decodeWrites()).toEqual(["bun run check\n"]);
    expect(getTerminalInitialCommand("term-early-exit")).toBeUndefined();
    unmount();
  });
});
