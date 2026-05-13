import type { IncomingMessage } from "node:http";

import { describe, expect, it } from "vitest";

import { isAuthorizedRequest } from "../src/lib/router.ts";

function req(headers: IncomingMessage["headers"] = {}): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe("Pencil router auth", () => {
  it("allows legacy launches without a configured token", () => {
    expect(isAuthorizedRequest(req(), new URL("http://127.0.0.1:49200/ipc"), undefined)).toBe(
      true
    );
  });

  it("rejects privileged endpoints without the per-launch token", () => {
    expect(isAuthorizedRequest(req(), new URL("http://127.0.0.1:49200/ipc"), "secret")).toBe(
      false
    );
  });

  it("accepts the token from UI headers or MCP/EventSource query strings", () => {
    expect(
      isAuthorizedRequest(
        req({ "x-deus-app-token": "secret" }),
        new URL("http://127.0.0.1:49200/ipc"),
        "secret"
      )
    ).toBe(true);
    expect(
      isAuthorizedRequest(
        req(),
        new URL("http://127.0.0.1:49200/events?token=secret"),
        "secret"
      )
    ).toBe(true);
  });
});
