import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ProjectAgent } from "@shared/projects";
import type { Part } from "@shared/protocol-types";
import { formatProjectPrompt } from "@shared/project-prompt";
import { SessionProvider } from "@/features/session/context";
import { ProjectConversationProvider } from "@/features/session/context/ProjectConversationContext";
import { describeOutcome } from "@/features/session/lib/projectInputs";
import { MessageItem } from "@/features/session/ui/MessageItem";
import type { Message } from "@/shared/types";

const agent = (id: string, title: string, role: ProjectAgent["role"]): ProjectAgent => ({
  id,
  workspaceId: id,
  sessionId: `${id}-session`,
  title,
  role,
  status: "idle",
  assignmentId: `${id}-assignment`,
  task: "",
  error: null,
  paused: false,
});
const agents = [
  agent("coord", "Pocket Ledger", "coordinator"),
  agent("csv", "CSV import", "contributor"),
];
const source = { agentId: "csv", sessionId: "csv-session", turnId: "turn-1" };

function userMessage(text: string): Message {
  const part: Part = {
    type: "text",
    id: "part",
    sessionId: "session",
    messageId: "message",
    partIndex: 0,
    text,
    state: "done",
  };
  return { id: "message", session_id: "session", seq: 1, role: "user", content: "", parts: [part] };
}

function render(text: string, project = true) {
  const message = React.createElement(MessageItem, { message: userMessage(text) });
  return renderToStaticMarkup(
    React.createElement(
      SessionProvider,
      { subagentMessages: new Map(), sessionStatus: "idle" },
      project
        ? React.createElement(
            ProjectConversationProvider,
            { value: { agents, openAgent: () => {} } },
            message
          )
        : message
    )
  );
}

describe("Project inputs in a managed conversation", () => {
  it("shows the welcome as a quiet event, not as something the user typed", () => {
    const html = render(
      formatProjectPrompt([
        { id: "w", origin: "system", kind: "welcome", message: "Write one short welcome." },
      ])
    );
    expect(html).toContain("Project started");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("[system/welcome");
    expect(html).not.toContain("Write one short welcome.");
  });

  it("names the agent behind a finished turn and offers to open it", () => {
    const outcome = JSON.stringify({
      agentId: "csv",
      outcome: { status: "completed" },
      reports: [{ id: "r", summary: "Imported 3 fixtures; 12 tests pass." }],
    });
    const html = render(
      formatProjectPrompt([
        { id: "o", origin: "system", kind: "turn_outcome", message: outcome, source },
        { id: "h", origin: "human", kind: "message", message: "Great, now add filters" },
      ])
    );
    expect(html).toContain("CSV import reported a result");
    expect(html).toContain("Imported 3 fixtures; 12 tests pass.");
    expect(html).toContain('aria-label="Open CSV import"');
    expect(html).toContain("Great, now add filters");
    expect(html).not.toContain("[human/message");
  });

  it("captions a message from another agent with its sender", () => {
    const html = render(
      formatProjectPrompt([
        {
          id: "d",
          origin: "agent",
          kind: "direction",
          message: "Implement the CSV importer",
          source: { agentId: "coord", sessionId: "coord-session", turnId: "turn-0" },
        },
      ])
    );
    expect(html).toContain("Assignment from");
    expect(html).toContain("Coordinator");
    expect(html).toContain("Implement the CSV importer");
  });

  it("leaves ordinary conversations and plain instructions untouched", () => {
    const prompt = "[system/welcome; input w] Looks like a header";
    expect(render(prompt, false)).toContain("[system/welcome; input w] Looks like a header");
    expect(render("Fix the login")).toContain("Fix the login");
    expect(render("Fix the login")).not.toContain("project-event");
  });
});

describe("describeOutcome", () => {
  it("reads stopped and failed turns", () => {
    expect(
      describeOutcome(
        JSON.stringify({
          agentId: "a",
          outcome: { status: "cancelled", reason: "Project stopped" },
        })
      )
    ).toEqual({ agentId: "a", verb: "was stopped", detail: "Project stopped", tone: "stopped" });
    expect(
      describeOutcome(
        JSON.stringify({ agentId: "a", outcome: { status: "failed", error: { message: "Boom" } } })
      )
    ).toEqual({ agentId: "a", verb: "failed", detail: "Boom", tone: "failed" });
    expect(describeOutcome("not json")).toMatchObject({
      verb: "reported back",
      detail: "not json",
    });
  });
});
