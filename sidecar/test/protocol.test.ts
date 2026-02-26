import { describe, it, expect } from "vitest";
import {
  QueryRequestSchema,
  CancelRequestSchema,
  ClaudeAuthRequestSchema,
  WorkspaceInitRequestSchema,
  ContextUsageRequestSchema,
  UpdatePermissionModeRequestSchema,
  ResetGeneratorRequestSchema,
  MessageResponseSchema,
  ErrorResponseSchema,
  EnterPlanModeNotificationSchema,
  AgentTypeSchema,
  isQueryRequest,
  isCancelRequest,
  isClaudeAuthRequest,
  isWorkspaceInitRequest,
  isContextUsageRequest,
  isUpdatePermissionModeRequest,
  isResetGeneratorRequest,
  SIDECAR_METHODS,
  SIDECAR_NOTIFICATIONS,
  FRONTEND_NOTIFICATIONS,
  FRONTEND_RPC_METHODS,
} from "../protocol";
import {
  buildQueryRequest,
  buildCancelRequest,
  buildClaudeAuthRequest,
  buildWorkspaceInitRequest,
  buildContextUsageRequest,
  buildUpdatePermissionModeRequest,
  buildResetGeneratorRequest,
  buildMessageResponse,
  buildErrorResponse,
  buildEnterPlanModeNotification,
} from "./builders";

// ============================================================================
// Constants
// ============================================================================

describe("RPC constants", () => {
  it("defines sidecar methods", () => {
    expect(SIDECAR_METHODS.QUERY).toBe("query");
    expect(SIDECAR_METHODS.CANCEL).toBe("cancel");
    expect(SIDECAR_METHODS.CLAUDE_AUTH).toBe("claudeAuth");
    expect(SIDECAR_METHODS.WORKSPACE_INIT).toBe("workspaceInit");
    expect(SIDECAR_METHODS.CONTEXT_USAGE).toBe("contextUsage");
  });

  it("defines sidecar notifications", () => {
    expect(SIDECAR_NOTIFICATIONS.UPDATE_PERMISSION_MODE).toBe("updatePermissionMode");
    expect(SIDECAR_NOTIFICATIONS.RESET_GENERATOR).toBe("resetGenerator");
  });

  it("defines frontend notifications", () => {
    expect(FRONTEND_NOTIFICATIONS.MESSAGE).toBe("message");
    expect(FRONTEND_NOTIFICATIONS.QUERY_ERROR).toBe("queryError");
    expect(FRONTEND_NOTIFICATIONS.ENTER_PLAN_MODE).toBe("enterPlanModeNotification");
  });

  it("defines frontend RPC methods", () => {
    expect(FRONTEND_RPC_METHODS.EXIT_PLAN_MODE).toBe("exitPlanMode");
    expect(FRONTEND_RPC_METHODS.ASK_USER_QUESTION).toBe("askUserQuestion");
    expect(FRONTEND_RPC_METHODS.GET_DIFF).toBe("getDiff");
    expect(FRONTEND_RPC_METHODS.DIFF_COMMENT).toBe("diffComment");
    expect(FRONTEND_RPC_METHODS.GET_TERMINAL_OUTPUT).toBe("getTerminalOutput");
  });
});

// ============================================================================
// AgentType Schema
// ============================================================================

describe("AgentTypeSchema", () => {
  it("accepts valid agent types", () => {
    expect(AgentTypeSchema.parse("claude")).toBe("claude");
    expect(AgentTypeSchema.parse("codex")).toBe("codex");
    expect(AgentTypeSchema.parse("unknown")).toBe("unknown");
  });

  it("rejects invalid agent types", () => {
    expect(() => AgentTypeSchema.parse("gpt")).toThrow();
    expect(() => AgentTypeSchema.parse("")).toThrow();
    expect(() => AgentTypeSchema.parse(123)).toThrow();
  });
});

// ============================================================================
// Zod Schemas
// ============================================================================

describe("QueryRequestSchema", () => {
  it("validates a complete query request", () => {
    const request = buildQueryRequest();
    const result = QueryRequestSchema.safeParse(request);
    expect(result.success).toBe(true);
  });

  it("validates with all optional fields", () => {
    const request = buildQueryRequest({
      options: {
        cwd: "/test",
        model: "opus",
        maxThinkingTokens: 5000,
        maxTurns: 100,
        turnId: "turn-1",
        permissionMode: "plan",
        claudeEnvVars: "FOO=bar",
        ghToken: "gh-token",
        opendevsEnv: { KEY: "value" },
        additionalDirectories: ["/extra"],
        chromeEnabled: true,
        strictDataPrivacy: false,
        shouldResetGenerator: true,
        resume: "session-id",
        resumeSessionAt: "2024-01-01",
      },
    });
    const result = QueryRequestSchema.safeParse(request);
    expect(result.success).toBe(true);
  });

  it("validates with only required fields", () => {
    const request = {
      type: "query",
      id: "sess-1",
      agentType: "claude",
      prompt: "hello",
      options: { cwd: "/test" },
    };
    const result = QueryRequestSchema.safeParse(request);
    expect(result.success).toBe(true);
  });

  it("rejects missing type", () => {
    const request = buildQueryRequest();
    delete (request as any).type;
    expect(QueryRequestSchema.safeParse(request).success).toBe(false);
  });

  it("rejects wrong type literal", () => {
    const request = buildQueryRequest({ type: "cancel" });
    expect(QueryRequestSchema.safeParse(request).success).toBe(false);
  });

  it("rejects missing cwd in options", () => {
    const request = { type: "query", id: "1", agentType: "claude", prompt: "hi", options: {} };
    expect(QueryRequestSchema.safeParse(request).success).toBe(false);
  });

  it("rejects invalid agentType", () => {
    const request = buildQueryRequest({ agentType: "gpt" });
    expect(QueryRequestSchema.safeParse(request).success).toBe(false);
  });
});

describe("CancelRequestSchema", () => {
  it("validates a cancel request", () => {
    const result = CancelRequestSchema.safeParse(buildCancelRequest());
    expect(result.success).toBe(true);
  });

  it("rejects wrong type", () => {
    expect(CancelRequestSchema.safeParse(buildCancelRequest({ type: "query" })).success).toBe(
      false
    );
  });

  it("rejects missing id", () => {
    const req = buildCancelRequest();
    delete (req as any).id;
    expect(CancelRequestSchema.safeParse(req).success).toBe(false);
  });
});

describe("ClaudeAuthRequestSchema", () => {
  it("validates a claude auth request", () => {
    expect(ClaudeAuthRequestSchema.safeParse(buildClaudeAuthRequest()).success).toBe(true);
  });

  it("accepts any valid agent type", () => {
    expect(
      ClaudeAuthRequestSchema.safeParse(buildClaudeAuthRequest({ agentType: "codex" })).success
    ).toBe(true);
    expect(
      ClaudeAuthRequestSchema.safeParse(buildClaudeAuthRequest({ agentType: "unknown" })).success
    ).toBe(true);
  });

  it("rejects invalid agent type", () => {
    expect(
      ClaudeAuthRequestSchema.safeParse(buildClaudeAuthRequest({ agentType: "gpt" })).success
    ).toBe(false);
  });
});

describe("WorkspaceInitRequestSchema", () => {
  it("validates a workspace init request", () => {
    expect(WorkspaceInitRequestSchema.safeParse(buildWorkspaceInitRequest()).success).toBe(true);
  });

  it("accepts optional ghToken and claudeEnvVars", () => {
    const req = buildWorkspaceInitRequest({
      options: { cwd: "/test", ghToken: "token", claudeEnvVars: "KEY=val" },
    });
    expect(WorkspaceInitRequestSchema.safeParse(req).success).toBe(true);
  });

  it("accepts any valid agent type", () => {
    expect(
      WorkspaceInitRequestSchema.safeParse(buildWorkspaceInitRequest({ agentType: "codex" }))
        .success
    ).toBe(true);
  });
});

describe("ContextUsageRequestSchema", () => {
  it("validates a context usage request", () => {
    expect(ContextUsageRequestSchema.safeParse(buildContextUsageRequest()).success).toBe(true);
  });

  it("accepts any valid agent type", () => {
    expect(
      ContextUsageRequestSchema.safeParse(buildContextUsageRequest({ agentType: "codex" })).success
    ).toBe(true);
  });

  it("rejects invalid agent type", () => {
    expect(
      ContextUsageRequestSchema.safeParse(buildContextUsageRequest({ agentType: "gpt" })).success
    ).toBe(false);
  });

  it("rejects missing claudeSessionId", () => {
    const req = buildContextUsageRequest({ options: { cwd: "/test" } });
    expect(ContextUsageRequestSchema.safeParse(req).success).toBe(false);
  });
});

describe("UpdatePermissionModeRequestSchema", () => {
  it("validates a permission mode update", () => {
    expect(
      UpdatePermissionModeRequestSchema.safeParse(buildUpdatePermissionModeRequest()).success
    ).toBe(true);
  });

  it("accepts any valid agent type", () => {
    expect(
      UpdatePermissionModeRequestSchema.safeParse(
        buildUpdatePermissionModeRequest({ agentType: "codex" })
      ).success
    ).toBe(true);
  });

  it("rejects missing permissionMode", () => {
    const req = buildUpdatePermissionModeRequest();
    delete (req as any).permissionMode;
    expect(UpdatePermissionModeRequestSchema.safeParse(req).success).toBe(false);
  });
});

describe("ResetGeneratorRequestSchema", () => {
  it("validates a reset generator request", () => {
    expect(ResetGeneratorRequestSchema.safeParse(buildResetGeneratorRequest()).success).toBe(true);
  });

  it("accepts any valid agent type", () => {
    expect(
      ResetGeneratorRequestSchema.safeParse(buildResetGeneratorRequest({ agentType: "codex" }))
        .success
    ).toBe(true);
  });

  it("rejects invalid agent type", () => {
    expect(
      ResetGeneratorRequestSchema.safeParse(buildResetGeneratorRequest({ agentType: "gpt" }))
        .success
    ).toBe(false);
  });
});

describe("MessageResponseSchema", () => {
  it("validates a message response", () => {
    expect(MessageResponseSchema.safeParse(buildMessageResponse()).success).toBe(true);
  });

  it("accepts any data shape", () => {
    const resp = buildMessageResponse({ data: { custom: "data", nested: [1, 2, 3] } });
    expect(MessageResponseSchema.safeParse(resp).success).toBe(true);
  });
});

describe("ErrorResponseSchema", () => {
  it("validates an error response", () => {
    expect(ErrorResponseSchema.safeParse(buildErrorResponse()).success).toBe(true);
  });

  it("rejects missing error string", () => {
    const resp = buildErrorResponse();
    delete (resp as any).error;
    expect(ErrorResponseSchema.safeParse(resp).success).toBe(false);
  });
});

describe("EnterPlanModeNotificationSchema", () => {
  it("validates enter plan mode notification", () => {
    expect(
      EnterPlanModeNotificationSchema.safeParse(buildEnterPlanModeNotification()).success
    ).toBe(true);
  });
});

// ============================================================================
// Type Guards
// ============================================================================

describe("Type guards", () => {
  describe("isQueryRequest", () => {
    it("returns true for valid query request", () => {
      expect(isQueryRequest(buildQueryRequest())).toBe(true);
    });

    it("returns false for cancel request", () => {
      expect(isQueryRequest(buildCancelRequest())).toBe(false);
    });

    it("returns false for null", () => {
      expect(isQueryRequest(null)).toBe(false);
    });

    it("returns false for string", () => {
      expect(isQueryRequest("not a request")).toBe(false);
    });
  });

  describe("isCancelRequest", () => {
    it("returns true for valid cancel request", () => {
      expect(isCancelRequest(buildCancelRequest())).toBe(true);
    });

    it("returns false for query request", () => {
      expect(isCancelRequest(buildQueryRequest())).toBe(false);
    });
  });

  describe("isClaudeAuthRequest", () => {
    it("returns true for valid auth request", () => {
      expect(isClaudeAuthRequest(buildClaudeAuthRequest())).toBe(true);
    });

    it("returns false for non-auth request", () => {
      expect(isClaudeAuthRequest(buildCancelRequest())).toBe(false);
    });
  });

  describe("isWorkspaceInitRequest", () => {
    it("returns true for valid workspace init request", () => {
      expect(isWorkspaceInitRequest(buildWorkspaceInitRequest())).toBe(true);
    });
  });

  describe("isContextUsageRequest", () => {
    it("returns true for valid context usage request", () => {
      expect(isContextUsageRequest(buildContextUsageRequest())).toBe(true);
    });
  });

  describe("isUpdatePermissionModeRequest", () => {
    it("returns true for valid permission mode request", () => {
      expect(isUpdatePermissionModeRequest(buildUpdatePermissionModeRequest())).toBe(true);
    });
  });

  describe("isResetGeneratorRequest", () => {
    it("returns true for valid reset generator request", () => {
      expect(isResetGeneratorRequest(buildResetGeneratorRequest())).toBe(true);
    });

    it("returns false for undefined", () => {
      expect(isResetGeneratorRequest(undefined)).toBe(false);
    });
  });
});
