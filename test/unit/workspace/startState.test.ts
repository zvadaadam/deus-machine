import { describe, expect, it, vi } from "vitest";
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
  provider_workspace_id: null,
  current_session_id: null,
} as const;
const labels = (start: ReturnType<typeof workspaceStart>) =>
  start.steps.map((step) => `${step.state}: ${step.label}`);

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

  it("folds its steps under one line, with no setup step when the project has none", () => {
    const start = workspaceStart(ready);
    expect(start).toMatchObject({ phase: "ready", summary: "Workspace ready", warnings: [] });
    expect(labels(start)).toEqual([
      "done: Checked for the latest changes",
      "done: Made a safe copy",
    ]);
    expect(labels(workspaceStart({ ...ready, setup_status: "completed" }))).toContain(
      "done: Ran setup"
    );
  });

  it("warns that it may be behind when the remote could not be fetched, and says why", () => {
    const start = workspaceStart({ ...ready, init_fetch_issue: "offline" });
    expect(labels(start)[0]).toBe("warning: Started without the latest changes");
    expect(start.warnings).toEqual([
      "Couldn't reach the remote repository, so this starts from what is already on this computer. It may be behind.",
    ]);
    expect(workspaceStart({ ...ready, init_fetch_issue: "auth" }).warnings[0]).toContain(
      "couldn't sign in"
    );
    expect(workspaceStart({ ...ready, init_fetch_issue: "failed" }).warnings[0]).toContain(
      "Couldn't get the latest"
    );
  });

  it("warns when it started without its setup script, with the script's failure", () => {
    const start = workspaceStart({
      ...ready,
      setup_status: "failed",
      error_message: "Setup exited with code 1.",
    });
    expect(start.phase).toBe("ready");
    expect(labels(start)).toContain("warning: Setup failed");
    expect(start.warnings).toEqual([
      "The setup script failed, so this workspace started without it. Setup exited with code 1.",
    ]);
  });
});

describe("a start that failed", () => {
  const failed = {
    ...local,
    state: "error",
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
  });

  it("can be retried or deleted while the row is all there is", () => {
    expect(canRecoverStart(failed)).toBe(true);
    expect(canRecoverStart({ ...failed, kind: "cloud" })).toBe(true);
  });

  it("cannot once it has a chat, a cloud computer, or is not a failure", () => {
    expect(canRecoverStart({ ...failed, current_session_id: "s" })).toBe(false);
    expect(canRecoverStart({ ...failed, kind: "cloud", provider_workspace_id: "vm" })).toBe(false);
    expect(canRecoverStart({ ...failed, state: "initializing" })).toBe(false);
    expect(canRecoverStart({ ...failed, state: "ready" })).toBe(false);
    expect(
      workspaceStart({ ...failed, kind: "cloud", provider_workspace_id: "vm" }).failure?.recoverable
    ).toBe(false);
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

  it("says nothing once ready, unless the setup script is running again or failed", () => {
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

  it("keeps no old copy on the device when the newest one does not fit", () => {
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (value.length > 400) throw new Error("QuotaExceededError");
        stored.set(key, value);
      },
      removeItem: (key: string) => stored.delete(key),
    });
    try {
      pendingFirstMessages.set("a", { message: "fix the login page", model: "opus" });
      expect(stored.get("workspace-start")).toContain("fix the login page");
      pendingFirstMessages.set("b", { message: "x".repeat(1000), model: "opus" });
      // A reload or a reopen must not bring back a copy without "b", where "a" may already be sent.
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
