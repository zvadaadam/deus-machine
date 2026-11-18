/**
 * A cloud computer's line in the transcript: which run of its events the line
 * tells, under which title, and when it is a line alone.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/platform/ws", () => ({ follow: vi.fn() }));

import type { CloudEnvEntry } from "../../../apps/web/src/features/session/store/cloudEnvStore";
import { buildGroup } from "../../../apps/web/src/features/session/ui/CloudEnvProgress";

let nextId = 1;
const event = (
  status: string,
  step: string | null = null,
  more: Partial<CloudEnvEntry> = {}
): CloudEnvEntry => ({
  id: nextId++,
  status,
  step,
  reason: null,
  snapshotRestored: false,
  at: 0,
  ...more,
});

const told = (entries: CloudEnvEntry[]) => {
  const group = buildGroup(entries);
  return (
    group && {
      title: group.title,
      state: group.state,
      steps: (group.steps ?? []).map((step) => `${step.icon}: ${step.label}`),
    }
  );
};

const firstStart = [
  event("provisioning", "initializing"),
  event("provisioning", "cloning_repository"),
];

describe("a cloud computer's line", () => {
  it("lists a start's steps under one title, the latest still running", () => {
    expect(told(firstStart)).toEqual({
      title: "Starting a cloud computer…",
      state: "running",
      steps: ["done: Initializing computer", "active: Cloning repository"],
    });
  });

  it("folds the steps behind ready", () => {
    expect(told([...firstStart, event("running")])).toEqual({
      title: "Computer ready",
      state: "ready",
      steps: ["done: Initializing computer", "done: Cloning repository"],
    });
  });

  it("tells a wake by its title, without the start that came before it", () => {
    const asleep = [...firstStart, event("running"), event("paused")];
    expect(told([...asleep, event("resuming")])).toEqual({
      title: "Waking computer",
      state: "running",
      steps: [],
    });
    const restoring = [
      ...asleep,
      event("resuming"),
      event("provisioning", "restoring_session_state"),
    ];
    expect(told(restoring)).toEqual({
      title: "Waking computer",
      state: "running",
      steps: ["active: Restoring session state"],
    });
    expect(told([...restoring, event("running", null, { snapshotRestored: true })])).toEqual({
      title: "Computer ready — session restored",
      state: "ready",
      steps: ["done: Restoring session state"],
    });
  });

  it("is one line when the computer rests or fails, and for a status it does not know", () => {
    expect(told([...firstStart, event("running"), event("paused")])).toMatchObject({
      state: "asleep",
      steps: [],
    });
    expect(told([...firstStart, event("error", null, { reason: "out of disk" })])).toEqual({
      title: "Computer error — out of disk",
      state: "failed",
      steps: [],
    });
    expect(told([event("migrating_region")])).toEqual({
      title: "Migrating region",
      state: "running",
      steps: [],
    });
    expect(told([])).toBeNull();
  });
});
