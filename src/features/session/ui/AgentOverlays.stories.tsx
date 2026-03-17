import { useState, useCallback } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { PlanApprovalOverlay } from "./PlanApprovalOverlay";
import { AgentQuestionOverlay } from "./AgentQuestionOverlay";
import { Button } from "@/components/ui/button";
import type { PlanModeRequest, AskQuestionRequest } from "../hooks/useAgentRpcHandler";

// ============================================================================
// PlanApprovalOverlay
// ============================================================================

const planMeta: Meta<typeof PlanApprovalOverlay> = {
  title: "Chat/AgentOverlays/PlanApproval",
  component: PlanApprovalOverlay,
  parameters: {
    layout: "centered",
  },
};
export default planMeta;

const mockPlanRequest: PlanModeRequest = {
  type: "exitPlanMode",
  sessionId: "sess-1",
  toolInput: { plan: "Refactor the auth module into separate files" },
  wsRequestId: "rpc-123",
};

export const Visible: StoryObj<typeof PlanApprovalOverlay> = {
  render: () => (
    <div className="w-[600px]">
      <PlanApprovalOverlay
        request={mockPlanRequest}
        agentType="claude"
        onApprove={() => console.log("Approved")}
        onReject={() => console.log("Rejected")}
      />
    </div>
  ),
};

export const Hidden: StoryObj<typeof PlanApprovalOverlay> = {
  render: () => (
    <div className="w-[600px]">
      <PlanApprovalOverlay
        request={null}
        agentType="claude"
        onApprove={() => {}}
        onReject={() => {}}
      />
      <p className="text-muted-foreground text-center text-sm">
        No pending plan — overlay is hidden
      </p>
    </div>
  ),
};

export const Interactive: StoryObj<typeof PlanApprovalOverlay> = {
  render: () => {
    const [request, setRequest] = useState<PlanModeRequest | null>(null);
    const [log, setLog] = useState<string[]>([]);

    const trigger = () => {
      setRequest(mockPlanRequest);
      setLog((prev) => [...prev, "Plan request received"]);
    };

    const approve = () => {
      setRequest(null);
      setLog((prev) => [...prev, "Plan approved"]);
    };

    const reject = () => {
      setRequest(null);
      setLog((prev) => [...prev, "Plan rejected"]);
    };

    return (
      <div className="w-[600px] space-y-4">
        <div className="flex justify-center">
          <Button onClick={trigger} disabled={!!request}>
            Simulate Plan Request
          </Button>
        </div>
        <PlanApprovalOverlay
          request={request}
          agentType="claude"
          onApprove={approve}
          onReject={reject}
        />
        {log.length > 0 && (
          <div className="bg-muted/30 rounded-lg p-3">
            <p className="text-muted-foreground mb-1 text-xs font-medium">Event log:</p>
            {log.map((entry, i) => (
              <p key={i} className="text-muted-foreground text-xs">
                {entry}
              </p>
            ))}
          </div>
        )}
      </div>
    );
  },
};

// ============================================================================
// AgentQuestionOverlay
// ============================================================================

const _questionMeta: Meta<typeof AgentQuestionOverlay> = {
  title: "Chat/AgentOverlays/AgentQuestion",
  component: AgentQuestionOverlay,
};

const mockSingleQuestion: AskQuestionRequest = {
  type: "askUserQuestion",
  sessionId: "sess-1",
  questions: [
    {
      question: "Which testing framework do you prefer?",
      options: ["Vitest", "Jest", "Mocha", "Playwright"],
    },
  ],
  wsRequestId: "rpc-456",
};

const mockMultiQuestion: AskQuestionRequest = {
  type: "askUserQuestion",
  sessionId: "sess-1",
  questions: [
    {
      question: "Which database should we use?",
      options: ["SQLite", "PostgreSQL", "MySQL"],
    },
    {
      question: "Which ORM do you prefer?",
      options: ["Drizzle", "Prisma", "Knex", "Raw SQL"],
    },
    {
      question: "Should we add caching?",
      options: ["Redis", "In-memory", "No caching"],
    },
  ],
  wsRequestId: "rpc-789",
};

const mockMultiSelect: AskQuestionRequest = {
  type: "askUserQuestion",
  sessionId: "sess-1",
  questions: [
    {
      question: "Which features should we include? (select all that apply)",
      options: ["Authentication", "File uploads", "WebSocket support", "Rate limiting"],
      multiSelect: true,
    },
  ],
  wsRequestId: "rpc-multi",
};

const mockMixedQuestions: AskQuestionRequest = {
  type: "askUserQuestion",
  sessionId: "sess-1",
  questions: [
    {
      question: "What type of project is this?",
      options: ["API", "Full-stack", "CLI tool", "Library"],
    },
    {
      question: "Which integrations do you need? (select all)",
      options: ["GitHub", "Slack", "Jira", "Linear"],
      multiSelect: true,
    },
    {
      question: "What deployment target?",
      options: ["Vercel", "AWS", "Self-hosted"],
    },
  ],
  wsRequestId: "rpc-mixed",
};

export const SingleQuestion: StoryObj<typeof AgentQuestionOverlay> = {
  render: () => (
    <div className="w-[600px]">
      <AgentQuestionOverlay
        request={mockSingleQuestion}
        agentType="claude"
        onSubmit={(answers) => console.log("Answers:", answers)}
        onDismiss={() => console.log("Dismissed")}
      />
    </div>
  ),
};

export const MultipleQuestions: StoryObj<typeof AgentQuestionOverlay> = {
  render: () => (
    <div className="w-[600px]">
      <AgentQuestionOverlay
        request={mockMultiQuestion}
        agentType="cursor"
        onSubmit={(answers) => console.log("Answers:", answers)}
        onDismiss={() => console.log("Dismissed")}
      />
    </div>
  ),
};

export const MultiSelect: StoryObj<typeof AgentQuestionOverlay> = {
  render: () => (
    <div className="w-[600px]">
      <AgentQuestionOverlay
        request={mockMultiSelect}
        agentType="codex"
        onSubmit={(answers) => console.log("Answers:", answers)}
        onDismiss={() => console.log("Dismissed")}
      />
    </div>
  ),
};

export const MixedSelectionTypes: StoryObj<typeof AgentQuestionOverlay> = {
  render: () => (
    <div className="w-[600px]">
      <AgentQuestionOverlay
        request={mockMixedQuestions}
        agentType="claude"
        onSubmit={(answers) => console.log("Answers:", answers)}
        onDismiss={() => console.log("Dismissed")}
      />
    </div>
  ),
};

export const QuestionInteractive: StoryObj<typeof AgentQuestionOverlay> = {
  name: "Interactive",
  render: () => {
    const [request, setRequest] = useState<AskQuestionRequest | null>(null);
    const [log, setLog] = useState<string[]>([]);

    const triggerSingle = () => {
      setRequest(mockSingleQuestion);
      setLog((prev) => [...prev, "Single question triggered"]);
    };

    const triggerMulti = () => {
      setRequest(mockMultiQuestion);
      setLog((prev) => [...prev, "Multi-question flow triggered"]);
    };

    const triggerMultiSelect = () => {
      setRequest(mockMultiSelect);
      setLog((prev) => [...prev, "Multi-select question triggered"]);
    };

    const onSubmit = useCallback((answers: (string | string[])[]) => {
      setRequest(null);
      setLog((prev) => [...prev, `Submitted: ${JSON.stringify(answers)}`]);
    }, []);

    const onDismiss = useCallback(() => {
      setRequest(null);
      setLog((prev) => [...prev, "Dismissed"]);
    }, []);

    return (
      <div className="w-[600px] space-y-4">
        <div className="flex justify-center gap-2">
          <Button size="sm" onClick={triggerSingle} disabled={!!request}>
            Single Q
          </Button>
          <Button size="sm" onClick={triggerMulti} disabled={!!request}>
            Multi Q
          </Button>
          <Button size="sm" onClick={triggerMultiSelect} disabled={!!request}>
            Multi-Select
          </Button>
        </div>
        <AgentQuestionOverlay
          request={request}
          agentType="claude"
          onSubmit={onSubmit}
          onDismiss={onDismiss}
        />
        {log.length > 0 && (
          <div className="bg-muted/30 rounded-lg p-3">
            <p className="text-muted-foreground mb-1 text-xs font-medium">Event log:</p>
            {log.map((entry, i) => (
              <p key={i} className="text-muted-foreground text-xs">
                {entry}
              </p>
            ))}
          </div>
        )}
      </div>
    );
  },
};

export const NoQuestion: StoryObj<typeof AgentQuestionOverlay> = {
  render: () => (
    <div className="w-[600px]">
      <AgentQuestionOverlay
        request={null}
        agentType="claude"
        onSubmit={() => {}}
        onDismiss={() => {}}
      />
      <p className="text-muted-foreground text-center text-sm">
        No pending question — overlay is hidden
      </p>
    </div>
  ),
};
