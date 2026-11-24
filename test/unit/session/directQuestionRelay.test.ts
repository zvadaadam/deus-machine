import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RuntimeClient } from "@/platform/ws/runtime-client";
import { api } from "@shared/api";
import {
  useAgentRpcHandler,
  type PendingAgentRequest,
} from "@/features/session/hooks/useAgentRpcHandler";
import { setDirectQuestionParked } from "@/features/session/cloud/directQuestionState";
import { Socket } from "../../../packages/runtime-client/test/socket";
import { describe, it, expect, vi } from "vitest";
import {
  toolRequestFromElicitation,
  buildElicitationResponseFrame,
} from "@/features/session/cloud/directSessionRegistry";

const QUESTIONS = [
  {
    id: "pref",
    question: "Prefer A or B?",
    options: [{ label: "A" }, { label: "B", description: "the other one" }],
  },
  { id: "notes", question: "Any notes?", multiSelect: true, options: [{ label: "Yes" }] },
];

describe("toolRequestFromElicitation (agnt elicitation.requested → the renderer's tool request)", () => {
  it("maps the engine's questions onto the card's shape and rewrites the session id", () => {
    const asked = toolRequestFromElicitation(
      {
        type: "elicitation.requested",
        sessionId: "provider-session",
        turnId: "turn-1",
        requestId: "req-1",
        mode: "question",
        questions: QUESTIONS,
      },
      "deus-session"
    );
    expect(asked?.request).toEqual({
      requestId: "req-1",
      sessionId: "deus-session",
      method: "askUserQuestion",
      params: {
        sessionId: "deus-session",
        questions: [
          { question: "Prefer A or B?", options: ["A", "B"] },
          { question: "Any notes?", options: ["Yes"], multiSelect: true },
        ],
      },
      timeoutMs: 24 * 60 * 60 * 1000,
    });
    expect(asked?.questions).toEqual(QUESTIONS);
  });

  it("asks only what the card shows, so the answers stay keyed to the right questions", () => {
    const asked = toolRequestFromElicitation(
      {
        requestId: "req-2",
        mode: "question",
        questions: [{ id: "blank", question: "" }, ...QUESTIONS],
      },
      "deus-session"
    );
    expect(asked?.questions.map((q) => q.id)).toEqual(["pref", "notes"]);
    expect(
      buildElicitationResponseFrame("req-2", "p", asked!.questions, { answers: ["A", ["Yes"]] })
        .data
    ).toMatchObject({ outcome: { action: "accept", content: { pref: "A", notes: ["Yes"] } } });
  });

  it("returns null without a request id, outside question mode, or with nothing to ask", () => {
    expect(toolRequestFromElicitation({ mode: "question", questions: QUESTIONS }, "s")).toBeNull();
    expect(
      toolRequestFromElicitation({ requestId: "r", mode: "form", message: "Fill in" }, "s")
    ).toBeNull();
    expect(
      toolRequestFromElicitation({ requestId: "r", mode: "question", questions: [] }, "s")
    ).toBeNull();
    expect(
      toolRequestFromElicitation(
        { requestId: "r", mode: "question", questions: [null, { id: "x", question: " " }] },
        "s"
      )
    ).toBeNull();
  });
});

describe("buildElicitationResponseFrame (renderer answer → agnt elicitation.respond)", () => {
  it("nests the outcome under data with the PROVIDER session id, answers keyed by question id", () => {
    expect(
      buildElicitationResponseFrame("req-1", "provider-session", QUESTIONS, {
        answers: ["B", ["Yes"]],
      })
    ).toEqual({
      type: "elicitation.respond",
      data: {
        sessionId: "provider-session",
        requestId: "req-1",
        outcome: { action: "accept", content: { pref: "B", notes: ["Yes"] } },
      },
    });
  });

  it("cancels on an error/empty/odd response so the agent unblocks, and declines USER_CANCELLED", () => {
    for (const result of [undefined, null, {}, { answers: [] }, "nope"]) {
      expect(buildElicitationResponseFrame("r", "p", QUESTIONS, result).data).toMatchObject({
        outcome: { action: "cancel" },
      });
    }
    expect(
      buildElicitationResponseFrame("r", "p", QUESTIONS, { answers: ["USER_CANCELLED"] }).data
    ).toMatchObject({ outcome: { action: "decline" } });
  });

  it("declines a request Deus has no card for", () => {
    expect(buildElicitationResponseFrame("r", "p", [], null).data).toMatchObject({
      outcome: { action: "decline" },
    });
  });
});

it("drops withdrawn backend cards at reconnect, replays pending ones and keeps a parked direct question", async () => {
  vi.stubGlobal("window", Object.assign(new EventTarget(), { HTMLIFrameElement: class {} }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(Object.assign(new EventTarget(), { nodeType: 9 }) as Document);
  const socket = new Socket();
  const runtime = new RuntimeClient(
    { host: "mac", account: "a", grant: "local" },
    { open: () => socket, heartbeatIntervalMs: 0 }
  );
  let shown: Map<string, PendingAgentRequest>;
  function Reader() {
    shown = useAgentRpcHandler({ sessionWorkspaces: new Map() }).pendingRequests;
    return null;
  }
  try {
    const connected = runtime.connect();
    await Promise.resolve();
    socket.open();
    socket.message({ type: "connected" });
    await connected;
    act(() =>
      root.render(
        createElement(QueryClientProvider, { client: runtime.queryClient }, createElement(Reader))
      )
    );
    const id = socket.frames("q:subscribe").find((sub) => sub.resource === "toolRequests")!.id;
    function request(sessionId: string, method: string) {
      return {
        type: "request" as const,
        request: {
          requestId: sessionId,
          sessionId,
          method,
          params: { sessionId, question: "Ready?" },
          timeoutMs: 60_000,
        },
      };
    }
    function present(sessionId: string, method: string) {
      socket.message({ type: "q:event", id, data: request(sessionId, method) });
    }
    setDirectQuestionParked("direct", true, runtime.queryClient);
    act(() => {
      runtime.publish(
        api.toolRequests,
        { sessionId: "direct" },
        request("direct", "askUserQuestion")
      );
      present("gone", "askUserQuestion");
      present("pending", "exitPlanMode");
    });
    expect([...shown!.keys()]).toEqual(["direct", "gone", "pending"]);
    act(() => {
      socket.message({ type: "server_reconnecting" });
      socket.message({ type: "connected" });
    });
    expect([...shown!.keys()]).toEqual(["direct"]);
    act(() => present("pending", "exitPlanMode"));
    expect([...shown!.keys()]).toEqual(["direct", "pending"]);
  } finally {
    act(() => root.unmount());
    runtime.dispose();
    vi.unstubAllGlobals();
  }
});
