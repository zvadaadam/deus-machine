import type { Mock } from "vitest";
import type { AnyOp, InputOf, OutputOf } from "@shared/api/op";
import type { AnyStream, EventOf, ScopeOf } from "@shared/api/stream";
import type { AssistantAccess } from "@shared/types/assistants";
import { LOCAL_CALLER, Registry, type Caller, type Handler } from "../src/api/registry";
import type { PublishOptions } from "../src/services/streams";

/**
 * What a test's stand-in for `publish` (services/streams) was asked to send on
 * one stream, in order: the scope each event was published under (who receives
 * it), the event, and its options.
 *
 *   const mockPublish = vi.hoisted(() => vi.fn());
 *   vi.mock("../../../src/services/streams", () => ({ publish: mockPublish }));
 *   expect(published(mockPublish, toolRequests)).toEqual([{ scope, event }]);
 */
export function published<S extends AnyStream>(
  publish: Mock,
  stream: S
): { scope: ScopeOf<S>; event: EventOf<S>; options: PublishOptions | undefined }[] {
  return publish.mock.calls
    .filter(([sent]) => (sent as AnyStream).name === stream.name)
    .map(([, scope, event, options]) => ({ scope, event, options }));
}

/** The account and machine the tests' assistants are admitted for. */
export const ASSISTANT_HOST = { accountId: "user_a", machineId: "0123456789abcdef" };

/** A hosted assistant's caller, admitted with `access`, as its relayed connection carries it. */
export function assistantCaller(access: AssistantAccess = "operate", clientId = "claude"): Caller {
  return { deviceId: null, relayed: true, assistant: { clientId, access, host: ASSISTANT_HOST } };
}

/**
 * Call operations the way a client's frame does: by name, through validation,
 * to the handler. A refusal rejects with the `AppError` the client would be
 * told about (`statusCode`, `message`, `details`).
 */
export function operations(handlers: Handler[], caller: Caller = LOCAL_CALLER) {
  const registry = new Registry(handlers);
  return <O extends AnyOp>(op: O, input?: InputOf<O>): Promise<OutputOf<O>> =>
    registry.run(op.name, op.kind, input, { caller }) as Promise<OutputOf<O>>;
}
