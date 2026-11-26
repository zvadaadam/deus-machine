import { expect, it } from "vitest";
import type { HarnessCli } from "@shared/agent-auth";
import { agentReadiness } from "@shared/agent-readiness";

const harness = "gemini";
const signedIn = { harness, state: "signed_in", methods: [] };

it.each([
  [undefined, "unknown", "Status unavailable"],
  [{ state: "missing" }, "not_installed", "Not available on this computer"],
  [{ state: "missing", version: "1" }, "unknown", "Installs on first use"],
  [{ state: "installing", receivedBytes: 1, totalBytes: 3 }, "unknown", "installing, 33%"],
  [{ state: "installing", receivedBytes: 0, totalBytes: 5 }, "unknown", "installing, 0%"],
  [{ state: "installing" }, "unknown", "installing"],
  [{ state: "failed", error: "Missing CLI override" }, "not_installed", "Missing CLI override"],
  [{ state: "failed" }, "not_installed", "Not available on this computer"],
  [
    { state: "failed", version: "1", error: "Offline" },
    "unknown",
    "its install failed: Offline; the next turn tries again",
  ],
  [{ state: "future", version: "1" }, "unknown", "Installs on first use"],
] satisfies [Omit<HarnessCli, "harness"> | undefined, string, string][])(
  "checks the CLI %j before trusting its login",
  (cli, state, detail) => {
    const clis = cli ? [{ harness, ...cli }] : [];
    expect(agentReadiness({ clis, auth: [signedIn] }, harness)).toMatchObject({ state, detail });
  }
);

it.each(["ready", "unmanaged"])("reads the login when the CLI is %s", (state) => {
  const clis = [{ harness, state }];
  const signedOut = { ...signedIn, state: "signed_out" };
  expect(agentReadiness({ clis, auth: [signedIn] }, harness)).toEqual({
    state: "ready",
    auth: signedIn,
  });
  expect(agentReadiness({ clis, auth: [signedOut] }, harness)).toEqual({
    state: "signed_out",
    auth: signedOut,
    detail: "sign in under Settings → AI Providers",
  });
  expect(agentReadiness({ clis, auth: [] }, harness)).toMatchObject({ state: "unknown" });
  for (const state of ["unknown", "future"]) {
    const auth = [{ ...signedIn, state, error: "The login check timed out" }];
    expect(agentReadiness({ clis, auth }, harness)).toMatchObject({
      state: "unknown",
      detail: "The login check timed out",
    });
  }
});
