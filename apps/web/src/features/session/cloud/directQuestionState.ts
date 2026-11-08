// apps/web/src/features/session/cloud/directQuestionState.ts
// Which direct (Mac-closed) sessions have a question parked for the user.
//
// Read by the discovery adapter when it builds workspace/session rows: agnt's
// dashboard keeps reporting a session blocked on AskUserQuestion as running,
// so without this the sidebar and the cloud home show a working spinner where
// they should show Needs Attention — and a question asked while the user was
// on another session is easy to miss until the agent times out. Written by
// the direct-session hook as questions are parked, answered and retracted.
// Kept in its own module so the adapter can read it without importing the
// hook (which imports the adapter's neighbours).

import { queryClient } from "@/shared/api/queryClient";
import type { QueryClient } from "@tanstack/react-query";

const parkedByCache = new WeakMap<QueryClient, Set<string>>();

export function setDirectQuestionParked(
  sessionId: string,
  parked: boolean,
  owner: QueryClient = queryClient
): void {
  let sessionsWithParkedQuestion = parkedByCache.get(owner);
  if (!sessionsWithParkedQuestion) {
    sessionsWithParkedQuestion = new Set();
    parkedByCache.set(owner, sessionsWithParkedQuestion);
  }
  if (parked) sessionsWithParkedQuestion.add(sessionId);
  else sessionsWithParkedQuestion.delete(sessionId);
}

export function hasParkedDirectQuestion(
  sessionId: string,
  owner: QueryClient = queryClient
): boolean {
  return parkedByCache.get(owner)?.has(sessionId) ?? false;
}
