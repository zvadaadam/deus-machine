import { describe, it, expect } from "vitest";
import { parseCommand } from "../lib/parse";

describe("parseCommand", () => {
  it("returns null for regular messages", () => {
    expect(parseCommand("fix the login bug")).toBeNull();
    expect(parseCommand("hello world")).toBeNull();
    expect(parseCommand("")).toBeNull();
  });

  it("parses /help command", () => {
    expect(parseCommand("/help")).toEqual({ type: "help" });
    expect(parseCommand("/start")).toEqual({ type: "help" });
  });

  it("parses /repos command", () => {
    expect(parseCommand("/repos")).toEqual({ type: "repos" });
    expect(parseCommand("/list")).toEqual({ type: "repos" });
  });

  it("parses /workspace command without args", () => {
    expect(parseCommand("/workspace")).toEqual({ type: "workspace", name: undefined });
    expect(parseCommand("/ws")).toEqual({ type: "workspace", name: undefined });
    expect(parseCommand("/bind")).toEqual({ type: "workspace", name: undefined });
  });

  it("parses /workspace command with name", () => {
    expect(parseCommand("/workspace happy-cat")).toEqual({ type: "workspace", name: "happy-cat" });
    expect(parseCommand("/ws my workspace")).toEqual({ type: "workspace", name: "my workspace" });
  });

  it("parses /status command", () => {
    expect(parseCommand("/status")).toEqual({ type: "status" });
  });

  it("parses /diff command", () => {
    expect(parseCommand("/diff")).toEqual({ type: "diff" });
  });

  it("parses /stop command", () => {
    expect(parseCommand("/stop")).toEqual({ type: "stop" });
    expect(parseCommand("/cancel")).toEqual({ type: "stop" });
  });

  it("parses /new command", () => {
    expect(parseCommand("/new")).toEqual({ type: "new", repoId: undefined });
    expect(parseCommand("/new repo-123")).toEqual({ type: "new", repoId: "repo-123" });
  });

  it("parses /unbind command", () => {
    expect(parseCommand("/unbind")).toEqual({ type: "unbind" });
  });

  it("handles @botname suffix (Telegram groups)", () => {
    expect(parseCommand("/help@MyBot")).toEqual({ type: "help" });
    expect(parseCommand("/repos@MyBot")).toEqual({ type: "repos" });
    expect(parseCommand("/workspace@MyBot happy-cat")).toEqual({
      type: "workspace",
      name: "happy-cat",
    });
  });

  it("is case insensitive for commands", () => {
    expect(parseCommand("/HELP")).toEqual({ type: "help" });
    expect(parseCommand("/Repos")).toEqual({ type: "repos" });
  });

  it("handles whitespace", () => {
    expect(parseCommand("  /help  ")).toEqual({ type: "help" });
    expect(parseCommand("/workspace   happy-cat  ")).toEqual({
      type: "workspace",
      name: "happy-cat",
    });
  });

  it("returns null for unknown commands", () => {
    expect(parseCommand("/unknown")).toBeNull();
    expect(parseCommand("/foo")).toBeNull();
  });
});
