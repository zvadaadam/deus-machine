import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { delegateToRoute, setApp } from "../../../src/services/route-delegate";
import { AppError } from "../../../src/lib/errors";

describe("route delegation", () => {
  it("preserves a repository conflict for the WebSocket mutation response", async () => {
    const existing = { id: "repo", root_path: "/project" };
    setApp(
      new Hono().post("/repo", (c) =>
        c.json({ error: "Repository already exists", details: existing }, 409)
      )
    );
    await expect(delegateToRoute("POST", "/repo", {})).rejects.toMatchObject({
      message: "Repository already exists",
      statusCode: 409,
      details: existing,
    });
  });

  it("preserves non-JSON failures as typed route errors", async () => {
    setApp(new Hono().get("/failure", (c) => c.text("Unavailable", 503)));
    await expect(delegateToRoute("GET", "/failure")).rejects.toEqual(
      new AppError(503, "Unavailable")
    );
  });
});
