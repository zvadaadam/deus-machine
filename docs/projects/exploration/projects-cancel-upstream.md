# Claude Project-pause classification — upstream fix, not yet consumed

The live Project pause exposed an existing `@zvada/agent-server` 0.3.8 engine bug. It is not a Project status-projection bug. The fix is implemented and tested in the authorized linked upstream worktree, but the Deus dependency and running bundle remain on the released, affected engine. No consumer error suppression or historical DB rewriting was added.

## Observed evidence

Root paused `Pocket Ledger — parallel delivery test` while two Claude agents were writing. Read-only inspection of `.context/project-smoke/deus.db` found project `01a0a0de-73d7-7437-8649-7abfa3247dfe` paused at `1789405955090`, and exact dispatch settlements with `{"status":"cancelled","reason":"Project stopped"}` for both turns:

| Turn                                   | Dispatch closed | Canonical turn ended |
| -------------------------------------- | --------------- | -------------------- |
| `01a0a0e0-d88f-7ceb-9009-c8a9270c7574` | `1789405955191` | `1789405955261`      |
| `01a0a0e6-df72-7fcf-9397-eb92378db164` | `1789405955276` | `1789405955269`      |

Both persisted canonical outcomes were `{"stopReason":"error","finishReason":"tool_use","error":{"category":"internal","message":"Claude turn ended: error_during_execution"}}`. Runtime log lines 381 and 384 show the same two `turn.ended stopReason=error` events. Session errors correctly made the overview show Needs attention despite the pause.

The raw SDK result was not logged. Its `stop_reason="tool_use"` is inferred from the canonical `finishReason`: `adapter.ts:525` copies non-null `msg.stop_reason` directly. The loaded `apps/agent-server/dist/index.bundled.cjs` contained the same classifier at lines 18924/19137/19139 as the installed 0.3.8 TypeScript, so this was not a stale-bundle/source mismatch.

## Exact boundary and minimal fix

Installed source: `node_modules/@zvada/agent-server/src/core/agents/claude-code/adapter.ts:528` classified `error_during_execution` as the ambiguous execution-failure/cancel shape **only when `stop_reason === null`**. With a retained `tool_use`, it set a generic error. `finish():289` requires `interrupted && (execFailure || !sawResult)`, so even an explicit interruption marker could not cancel that shape.

The upstream agent emits `turn_interrupted` from its own per-turn abort signal at `claude-agent.ts:244` (line 243 after the comment edit). Its `cancel()` aborts that controller before awaiting the SDK interrupt acknowledgment. The marker proves an interruption was requested on that execution; it is distinct from the wire cancel acknowledgment. The wire acknowledgment governs whether a caller can safely settle/restart work. Canonical `turn.ended` remains the terminal outcome source of truth.

The bounded upstream change removes only the null-stop-reason gate. `error_during_execution` is now disambiguated by the existing engine marker for either null or retained model stop reasons. A failure without that marker remains an error. A different explicit terminal failure remains an error even with the marker. A successful terminal result remains success even if a late marker arrives. This retains the existing engine policy for the ambiguous subtype; it does not infer cancellation from paused Project state, generic error text, or an unconfirmed consumer request.

Semantic limit: the marker proves the controller was aborted, not that the abort caused the SDK failure. A coincident genuine `error_during_execution` plus abort is indistinguishable at this boundary; that ambiguity already existed for null stop reasons. An independent source review found no blocking defect in applying the same policy to retained stop reasons.

The consumer has already lost the marker by `apps/backend/src/services/agent/persistence.ts:243`; reinterpreting its generic canonical error from Project state would hide real failures. No change was made there or to status priority.

## Upstream checkout and changes

Authorized worktree: `/Users/zvada/conductor/workspaces/agent-server/thimphu`, branch `projects-feature`, HEAD `b1c3e90` (`Report Claude query cost once per turn (#57)`). It was clean before editing. The root `CLAUDE.md` and package `AGENTS.md` were read. Its package is still version 0.3.8; there was no package bump, commit, push, publish, or consumer pin change.

Files changed for this issue:

- `packages/agent-server/src/core/agents/claude-code/adapter.ts:528`: remove the null-only gate, clarify the marker policy.
- `packages/agent-server/src/core/agents/claude-code/claude-agent.ts:240`: correct the stale comment claiming null is the only interrupt result shape. No behavior change in this file for this issue.
- `packages/agent-server/test/core/adapters/claude-code.test.ts:352`: parameterize cancellation and true-error controls across null/tool_use; add distinct terminal error and late-success controls.

The isolated patch is saved as `.context/projects-cancel-upstream.patch`. Another agent may subsequently edit Claude session handling for a separate zero-token-turn investigation; that is outside this patch.

## Verification and remaining work

- Before the production fix, the upstream adapter suite had exactly **1 failure / 52 passes**: interrupted `error_during_execution` with `tool_use` emitted error instead of cancelled.
- After the fix, all **53 adapter tests pass** using Node 22 and the upstream Bun test script.
- Upstream `bun run typecheck` and `bun run lint:fix` pass; `git diff --check` passes. Dependencies were installed from the existing frozen Bun lockfile with scripts disabled; the lockfile did not change.
- Deus `apps/backend/test/unit/services/projects-cancel-classification.test.ts` qualifies the installed package without a model process. It has **one explicitly expected failure** for the known 0.3.8 bug and three passing control tests. Its green result does **not** mean Deus has consumed the fix; remove `.fails` when a fixed engine version is installed.
- No real models or app processes were started for this investigation. The upstream patch has not yet been verified in a live Deus pause. The remaining integration work is to release/consume the fixed engine through the normal package path and repeat the live pause case; previous persisted errors are historical evidence and remain unchanged.
