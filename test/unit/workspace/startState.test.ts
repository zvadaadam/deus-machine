import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkspaceStartGroup } from "@/features/session/ui/WorkspaceStartGroup";

// Which kind of window this is: a browser tab unless a test says the desktop app.
const platform = vi.hoisted(() => ({ singleWindow: false }));
vi.mock("@/platform/capabilities", () => ({ capabilities: platform }));
vi.mock("@/features/workspace/hooks/useSetupActions", () => ({
  useSetupActions: (workspaceId: string) => ({ workspaceId, retry: vi.fn(), retrying: false }),
}));
vi.mock("@/features/workspace/hooks/useStartRecovery", () => ({ useStartRecovery: vi.fn() }));

import {
  canRecoverStart,
  failedToStart,
  hasCheckout,
  workspaceStart,
} from "@/features/workspace/lib/startState";
import {
  markStartedIn,
  pendingFirstMessages,
  useWorkspaceStartStore,
} from "@/features/workspace/store/workspaceStartStore";

const local = {
  kind: "worktree",
  state: "initializing",
  init_stage: "fetch",
  init_fetch_issue: null,
  setup_status: "none",
  error_message: null,
  error_detail: null,
  start_recoverable: false,
  current_session_id: null,
} as const;
const labels = (start: ReturnType<typeof workspaceStart>) =>
  start.steps.map((step) => `${step.state}: ${step.label}`);
const warnings = (start: ReturnType<typeof workspaceStart>) =>
  start.steps.flatMap((step) => (step.warning ? [step.warning] : []));

describe("a starting workspace", () => {
  it("lists the step in progress under one line, with the ones before it done", () => {
    expect(workspaceStart(local)).toMatchObject({
      phase: "starting",
      cloud: false,
      summary: "Setting up workspace…",
    });
    expect(labels(workspaceStart(local))).toEqual(["active: Getting the latest changes…"]);
    const copying = workspaceStart({ ...local, init_stage: "worktree" });
    expect(copying.summary).toBe("Setting up workspace…");
    expect(labels(copying)).toEqual([
      "done: Checked for the latest changes",
      "active: Making a safe copy…",
    ]);
    const settingUp = workspaceStart({ ...local, init_stage: "setup", setup_status: "running" });
    expect(settingUp.summary).toBe("Setting up workspace…");
    expect(labels(settingUp)).toEqual([
      "done: Checked for the latest changes",
      "done: Made a safe copy",
      "active: Running setup…",
    ]);
  });

  it("has words for a stage it does not know, and for a cloud computer", () => {
    expect(workspaceStart({ ...local, init_stage: null }).summary).toBe("Setting up workspace…");
    expect(
      workspaceStart({ ...local, kind: "cloud", init_stage: "provisioning sandbox" })
    ).toMatchObject({ cloud: true, summary: "Starting a cloud computer…", steps: [] });
  });
});

describe("a workspace that started", () => {
  const ready = { ...local, state: "ready", init_stage: "done", current_session_id: "s" } as const;

  it("renders a running step in the live chat and only the ready title once it finishes", () => {
    const render = (setup_status: "running" | "completed") =>
      renderToStaticMarkup(
        createElement(WorkspaceStartGroup, {
          workspaceId: "w",
          start: workspaceStart({ ...ready, setup_status }),
        })
      );
    expect(render("running")).toContain("Running setup…");
    const settled = render("completed");
    expect(settled).toContain("Workspace ready");
    expect(settled).toContain('aria-expanded="false"');
    expect(settled).not.toMatch(/Running setup|Ran setup|setup finished/i);
  });

  it("has a usable checkout and chat while its setup step is still running", () => {
    const workspace = { ...ready, setup_status: "running" } as const;
    expect(hasCheckout(workspace)).toBe(true);
    const start = workspaceStart(workspace);
    expect(start).toMatchObject({
      phase: "ready",
      summary: "Workspace ready",
      brief: "Running setup…",
    });
    expect(warnings(start)).toEqual([]);
    expect(labels(start)).toEqual([
      "done: Checked for the latest changes",
      "done: Made a safe copy",
      "active: Running setup…",
    ]);
  });

  it("folds its steps under one line, with no setup step when the project has none", () => {
    const start = workspaceStart(ready);
    expect(start).toMatchObject({ phase: "ready", summary: "Workspace ready" });
    expect(warnings(start)).toEqual([]);
    expect(labels(start)).toEqual([
      "done: Checked for the latest changes",
      "done: Made a safe copy",
    ]);
    const finished = workspaceStart({ ...ready, setup_status: "completed" });
    expect(finished.summary).toBe("Workspace ready");
    expect(finished.brief).toBeNull();
    expect(warnings(finished)).toEqual([]);
    expect(labels(finished)).toContain("done: Ran setup");
  });

  it("keeps the fetch step in place when the project has no origin", () => {
    const start = workspaceStart({ ...ready, init_fetch_issue: "no_origin" });
    expect(labels(start)).toEqual(["done: No origin to check", "done: Made a safe copy"]);
    expect(warnings(start)).toEqual([]);
  });

  it("shows the generic fetch warning for an issue reported by a newer host", () => {
    const row = JSON.parse(JSON.stringify({ ...ready, init_fetch_issue: "remote_busy" }));
    expect(warnings(workspaceStart(row))).toEqual([
      { message: "We couldn’t get the latest changes, so this copy may be out of date." },
    ]);
  });

  it("warns that it may be behind when the remote could not be fetched, and says why", () => {
    const start = workspaceStart({ ...ready, init_fetch_issue: "offline" });
    expect(labels(start)[0]).toBe("warning: Copy may be out of date");
    expect(warnings(start)).toEqual([
      { message: "We couldn’t reach the remote, so this copy may be out of date." },
    ]);
    expect(warnings(workspaceStart({ ...ready, init_fetch_issue: "auth" }))[0].message).toContain(
      "couldn’t sign in"
    );
    expect(warnings(workspaceStart({ ...ready, init_fetch_issue: "failed" }))[0].message).toContain(
      "couldn’t get the latest"
    );
  });

  it("previews the exit code when the script printed nothing", () => {
    const start = workspaceStart({
      ...ready,
      setup_status: "failed",
      error_message: "Setup exited with code 17. View the setup log for details.",
    });
    expect(start.phase).toBe("ready");
    expect(labels(start)).toContain("warning: Setup failed");
    expect(warnings(start)).toEqual([
      {
        message:
          "Setup exited with code 17. The agent can see the error, and you can keep working.",
        preview: "exit code 17",
      },
    ]);
  });

  it("keeps warnings with their own steps and the literal script output apart from the explanation", () => {
    const start = workspaceStart({
      ...ready,
      setup_status: "failed",
      init_fetch_issue: "offline",
      error_message: "Setup exited with code 1.",
      error_detail: "Checking tools\r\nMissing <b>clang</b>\n",
    });
    expect(start.steps.filter((step) => step.warning).map((step) => step.key)).toEqual([
      "fetch",
      "setup",
    ]);
    expect(warnings(start)).toEqual([
      { message: "We couldn’t reach the remote, so this copy may be out of date." },
      {
        message: "Setup exited with code 1. The agent can see the error, and you can keep working.",
        preview: "Missing <b>clang</b>",
        output: "Checking tools\r\nMissing <b>clang</b>\n",
      },
    ]);
    expect(start.brief).toBe("Setup failed");
  });

  it("handles interrupted setup and older rows without an exit code or a tail", () => {
    const failed = { ...ready, setup_status: "failed" } as const;
    expect(
      warnings(
        workspaceStart({
          ...failed,
          error_message: "Setup was stopped when Deus closed. Run it again.",
        })
      )[0].preview
    ).toBe("Deus closed");
    expect(warnings(workspaceStart(failed))).toEqual([
      { message: "Setup didn’t finish. The agent can see the error, and you can keep working." },
    ]);
  });
});

describe("a start that failed", () => {
  const failed = {
    ...local,
    state: "error",
    start_recoverable: true,
    init_stage: "worktree",
    error_message: 'The branch "develop" does not exist in this project.',
    error_detail: "fatal: invalid reference: develop",
  } as const;

  it("says why, keeps the tool's words, and marks what was done before it", () => {
    const start = workspaceStart(failed);
    expect(start).toMatchObject({
      phase: "failed",
      summary: "Workspace didn't start",
      failure: {
        reason: 'The branch "develop" does not exist in this project.',
        detail: "fatal: invalid reference: develop",
        recoverable: true,
      },
    });
    expect(labels(start)).toEqual(["done: Checked for the latest changes"]);
    expect(warnings(start)).toEqual([]);
  });

  it("offers recovery only when the backend allows it", () => {
    expect(workspaceStart({ ...failed, start_recoverable: false }).failure?.recoverable).toBe(
      false
    );
    expect(canRecoverStart({})).toBe(false);
  });
});

describe("a start in a few words, for the sidebar row", () => {
  const ready = { ...local, state: "ready", init_stage: "done", current_session_id: "s" } as const;

  it("names the step in progress, shortened where the line is too long", () => {
    expect(workspaceStart(local).brief).toBe("Updating…");
    expect(workspaceStart({ ...local, init_stage: "worktree" }).brief).toBe("Copying…");
    expect(workspaceStart({ ...local, init_stage: "setup", setup_status: "running" }).brief).toBe(
      "Running setup…"
    );
    expect(workspaceStart({ ...local, init_stage: null }).brief).toBe("Starting…");
    expect(workspaceStart({ ...local, kind: "cloud", init_stage: "provisioning" }).brief).toBe(
      "Starting…"
    );
  });

  it("says a start failed, and whose", () => {
    expect(workspaceStart({ ...local, state: "error" }).brief).toBe("Failed");
    expect(workspaceStart({ ...local, state: "error", kind: "cloud" }).brief).toBe(
      "Computer failed"
    );
  });

  it("says nothing once ready, unless the setup script is running or failed", () => {
    expect(workspaceStart(ready).brief).toBeNull();
    expect(workspaceStart({ ...ready, kind: "cloud" }).brief).toBeNull();
    expect(workspaceStart({ ...ready, setup_status: "completed" }).brief).toBeNull();
    expect(workspaceStart({ ...ready, setup_status: "running" }).brief).toBe("Running setup…");
    expect(workspaceStart({ ...ready, setup_status: "failed" }).brief).toBe("Setup failed");
  });
});

describe("somewhere to work", () => {
  it("exists once the workspace has a chat", () => {
    expect(hasCheckout(local)).toBe(false);
    expect(hasCheckout({ current_session_id: "s" })).toBe(true);
  });

  it("is what a failed start lacks; a workspace that broke later still has it", () => {
    expect(failedToStart({ state: "error", current_session_id: null })).toBe(true);
    expect(failedToStart({ state: "error", current_session_id: "s" })).toBe(false);
    expect(failedToStart({ state: "initializing", current_session_id: null })).toBe(false);
  });
});

describe("what a client remembers of a start", () => {
  it("keeps the waiting message per workspace until it is cleared", () => {
    pendingFirstMessages.set("a", { message: "fix the login page", model: "opus" });
    pendingFirstMessages.set("b", { message: "add dark mode", model: "opus" });

    expect(pendingFirstMessages.get("a")?.message).toBe("fix the login page");
    pendingFirstMessages.clear("a");
    expect(pendingFirstMessages.get("a")).toBeUndefined();
    // Another workspace's message is untouched.
    expect(pendingFirstMessages.get("b")?.message).toBe("add dark mode");

    // Clearing what is not there changes nothing, so nothing re-renders.
    const before = useWorkspaceStartStore.getState();
    pendingFirstMessages.clear("a");
    expect(useWorkspaceStartStore.getState()).toBe(before);
    pendingFirstMessages.clear("b");
  });

  const storage = (kept: Map<string, string>, limit = Infinity) => ({
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (value.length > limit) throw new Error("QuotaExceededError");
      kept.set(key, value);
    },
    removeItem: (key: string) => kept.delete(key),
  });

  it("keeps the waiting message in the tab in a browser, and on the device in the desktop app", () => {
    const tab = new Map<string, string>();
    const device = new Map<string, string>();
    vi.stubGlobal("sessionStorage", storage(tab));
    vi.stubGlobal("localStorage", storage(device));
    try {
      // A browser tab: another tab of the same browser must not find it and send it too.
      pendingFirstMessages.set("a", { message: "fix the login page", model: "opus" });
      expect(tab.get("workspace-start")).toContain("fix the login page");
      expect(device.size).toBe(0);

      // The desktop app's one window: the message is still there after a quit.
      platform.singleWindow = true;
      pendingFirstMessages.set("b", { message: "add dark mode", model: "opus" });
      expect(device.get("workspace-start")).toContain("add dark mode");
    } finally {
      platform.singleWindow = false;
      pendingFirstMessages.clear("a");
      pendingFirstMessages.clear("b");
      vi.unstubAllGlobals();
    }
  });

  it("keeps no old copy when the newest one does not fit", () => {
    const stored = new Map<string, string>();
    vi.stubGlobal("sessionStorage", storage(stored, 400));
    try {
      pendingFirstMessages.set("a", { message: "fix the login page", model: "opus" });
      expect(stored.get("workspace-start")).toContain("fix the login page");
      pendingFirstMessages.set("b", { message: "x".repeat(1000), model: "opus" });
      // A reload must not bring back a copy without "b", where "a" may already be sent.
      expect(stored.has("workspace-start")).toBe(false);
    } finally {
      pendingFirstMessages.clear("a");
      pendingFirstMessages.clear("b");
      vi.unstubAllGlobals();
    }
  });

  it("remembers the chat a workspace started with", () => {
    markStartedIn("a", "session-1");
    expect(useWorkspaceStartStore.getState().startedIn).toEqual({ a: "session-1" });
    const before = useWorkspaceStartStore.getState();
    markStartedIn("a", "session-1");
    expect(useWorkspaceStartStore.getState()).toBe(before);
  });
});
