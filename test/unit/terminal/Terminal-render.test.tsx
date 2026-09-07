import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, render } from "@testing-library/react";

// T11 attempt: render Terminal.tsx under happy-dom and confirm the
// "Failed to start terminal:" banner is written to xterm when
// ptyCommands.spawn rejects (the path that was dead-code in the bug).
//
// pty.ts imports sendCommand via the deep path @/platform/ws/query-protocol-client
// and Terminal.tsx imports ptyCommands via @/platform. Mock both, then drive
// ptyCommands.spawn to reject.

const { sendCommand, onEvent } = vi.hoisted(() => ({
  sendCommand: vi.fn(),
  onEvent: vi.fn(() => () => {}),
}));

vi.mock("@/platform/ws/query-protocol-client", () => ({ sendCommand, onEvent }));

const { ptyCommands } = vi.hoisted(() => ({
  ptyCommands: {
    spawn: vi.fn(),
    write: vi.fn(() => Promise.resolve()),
    resize: vi.fn(() => Promise.resolve()),
    kill: vi.fn(() => Promise.resolve()),
  },
}));
vi.mock("@/platform", () => ({ ptyCommands }));

// Capture xterm writes so we can assert the red banner appears without
// needing a real xterm renderer.
const writes: string[] = [];
let openFailure: unknown = null;

vi.mock("@xterm/xterm", () => {
  return {
    Terminal: class {
      cols = 80;
      rows = 24;
      onData() {
        return { dispose: () => {} };
      }
      open(container: unknown) {
        // happy-dom may lack the canvas/render service xterm expects; capture any error.
        try {
          (container as HTMLElement).getBoundingClientRect();
        } catch (e) {
          openFailure = e;
          throw e;
        }
      }
      write(s: string) {
        writes.push(s);
      }
      clear() {}
      dispose() {}
      loadAddon() {}
    },
  };
});
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("./Terminal.css", () => ({}));

import { Terminal as TerminalComponent } from "@/features/terminal/ui/Terminal";

afterEach(() => {
  cleanup();
  writes.length = 0;
  openFailure = null;
});

describe("Terminal.tsx — spawn-rejection UI (T11 attempt, happy-dom)", () => {
  it("renders and writes the 'Failed to start terminal:' banner when spawn rejects (cloud no-session)", async () => {
    const ptyId = "ts1";
    (ptyCommands.spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      // Mirror the fix's exact rejection: the cloud no-session sync-throw ack.
      Promise.reject(new Error("Cloud workspace has no active session for a terminal"))
    );

    let renderErr: unknown = null;
    try {
      render(
        <TerminalComponent
          id={ptyId}
          workspacePath="/tmp"
          cloudWorkspaceId="ws-cloud"
          visible={true}
        />
      );
    } catch (e) {
      renderErr = e;
    }
    if (renderErr) {
      throw renderErr;
    }

    // Give the spawn promise a tick to settle.
    await new Promise((r) => setTimeout(r, 50));

    // Only assert on banner content if we got past open(); if xterm.open threw on
    // a missing canvas context, the writes array stays empty and we surface that.
    const banner = writes.join("");
    expect(banner).toContain("Failed to start terminal:");
    expect(banner).toContain("Cloud workspace has no active session for a terminal");
    expect(banner).toContain("Press Enter to retry");
    expect(openFailure).toBeNull();
  });

  it("happy-path regression: an accepted spawn does NOT write the 'Failed to start terminal:' banner", async () => {
    (ptyCommands.spawn as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      Promise.resolve(undefined)
    );

    render(<TerminalComponent id="ts2" workspacePath="/tmp" visible={true} />);

    // Allow the spawn promise + effect flush to settle.
    await new Promise((r) => setTimeout(r, 80));

    const banner = writes.join("");
    expect(banner).not.toContain("Failed to start terminal:");
    expect(banner).not.toContain("Press Enter to retry");
    expect(openFailure).toBeNull();
  });
});
