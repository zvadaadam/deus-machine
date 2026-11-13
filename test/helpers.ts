import type { Mock } from "vitest";
import { scopeMatches, type AnyStream, type EventOf, type ScopeOf } from "@shared/api/stream";

/**
 * For a test's stand-in for `follow` (`@/platform/ws`): a mock that hands each
 * caller its own stop function, which is how these helpers know who still
 * follows.
 *
 *   const follow = vi.hoisted(() => vi.fn(() => vi.fn()));
 *   vi.mock("@/platform/ws", () => ({ follow }));
 *
 *   emit(follow, api.simulatorEvents, { workspaceId }, { type: "buildLog", line });
 *   expect(following(follow)).toEqual([{ stream: "simulatorEvents", filter: { workspaceId } }]);
 */
type FollowCall = [
  stream: AnyStream,
  filter: Record<string, unknown>,
  onEvent: (event: unknown) => void,
  options?: { onReset?: () => void },
];

/** The calls whose stop function has not been called, in the order they were made. */
function current(follow: Mock): FollowCall[] {
  return (follow.mock.calls as FollowCall[]).filter((_call, index) => {
    const stop = follow.mock.results[index]?.value as Mock | undefined;
    return !stop?.mock.calls.length;
  });
}

/** Who follows now, in the order they began: the stream's name and the filter they gave. */
export function following(follow: Mock): { stream: string; filter: Record<string, unknown> }[] {
  return current(follow).map(([stream, filter]) => ({ stream: stream.name, filter }));
}

/**
 * The host publishes `event` on `stream` under `scope`. As on the wire, it
 * reaches the followers of that stream whose filter the scope matches, and
 * nobody else.
 */
export function emit<S extends AnyStream>(
  follow: Mock,
  stream: S,
  scope: ScopeOf<S>,
  event: EventOf<S>
): void {
  for (const [followed, filter, onEvent] of current(follow)) {
    if (followed.name === stream.name && scopeMatches(filter, scope as Record<string, unknown>))
      onEvent(event);
  }
}

/**
 * The connection came back and the host cannot say what the followers of
 * `stream` under `scope` missed: their `onReset` runs.
 */
export function reset<S extends AnyStream>(follow: Mock, stream: S, scope: ScopeOf<S>): void {
  for (const [followed, filter, , options] of current(follow)) {
    if (followed.name === stream.name && scopeMatches(filter, scope as Record<string, unknown>))
      options?.onReset?.();
  }
}
