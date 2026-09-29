import { describe, expect, it } from "vitest";
import { formatProjectPrompt, parseProjectPrompt } from "@shared/project-prompt";

const source = { agentId: "agent-1", sessionId: "session-1", turnId: "turn-1" };

describe("Project prompt format", () => {
  it("keeps a lone human instruction verbatim", () => {
    const prompt = formatProjectPrompt([
      { id: "a", origin: "human", kind: "message", message: "Fix the login\n\nAnd add tests" },
    ]);
    expect(prompt).toBe("Fix the login\n\nAnd add tests");
    expect(parseProjectPrompt(prompt)).toEqual([{ type: "text", text: prompt }]);
  });

  it("round-trips a mixed batch, including paragraphs inside a message", () => {
    const outcome = JSON.stringify({ agentId: "agent-1", outcome: { status: "completed" } });
    const prompt = formatProjectPrompt([
      { id: "o", origin: "system", kind: "turn_outcome", message: outcome, source },
      { id: "q", origin: "agent", kind: "question", message: "Which API?\n\nREST or RPC?", source },
      { id: "h", origin: "human", kind: "message", message: "Use REST" },
    ]);
    expect(parseProjectPrompt(prompt)).toEqual([
      {
        type: "input",
        origin: "system",
        kind: "turn_outcome",
        inputId: "o",
        fromAgentId: "agent-1",
        text: outcome,
      },
      {
        type: "input",
        origin: "agent",
        kind: "question",
        inputId: "q",
        fromAgentId: "agent-1",
        text: "Which API?\n\nREST or RPC?",
      },
      {
        type: "input",
        origin: "human",
        kind: "message",
        inputId: "h",
        fromAgentId: null,
        text: "Use REST",
      },
    ]);
  });

  it("reads prompts written before human inputs were labelled", () => {
    const prompt =
      "Earlier instruction\n\n[system/welcome; input 01a0ca19-8bd8] This Project has no brief yet.";
    expect(parseProjectPrompt(prompt)).toEqual([
      { type: "text", text: "Earlier instruction" },
      {
        type: "input",
        origin: "system",
        kind: "welcome",
        inputId: "01a0ca19-8bd8",
        fromAgentId: null,
        text: "This Project has no brief yet.",
      },
    ]);
  });

  it("ignores bracketed text that is not a header at a paragraph start", () => {
    const prompt = "See [system/welcome; input x] inline, which is only quoted text.";
    expect(parseProjectPrompt(prompt)).toEqual([{ type: "text", text: prompt }]);
  });
});
