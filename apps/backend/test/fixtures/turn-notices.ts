import { vi } from "vitest";
import { connectTurnNotices } from "../../src/services/agent/chat-turn";

export function wireTestTurnNotices(
  overrides: Partial<Parameters<typeof connectTurnNotices>[0]> = {}
) {
  connectTurnNotices({
    queue: vi.fn(),
    recover: vi.fn(),
    withdrawCards: vi.fn(),
    stored: vi.fn(),
    ...overrides,
  });
}
