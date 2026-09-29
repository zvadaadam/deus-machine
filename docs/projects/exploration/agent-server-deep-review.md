# Agent-server: queueing, steering and provider lifecycle review

15 September 2026. Upstream source: `/Users/zvada/conductor/workspaces/agent-server/thimphu`. This report supplements the earlier local Projects verification.

## Decision

Keep durable queued work in Deus/agnt and execute it through one shared AgentRuntime contract. Queueing means a later turn; steering means additional input to the same active turn. Agent-server currently exposes queue-compatible run/cancel primitives, not a public steering API or persistent task queue.

For current Projects, keep Claude until Codex has equivalent Project tool/source-identity integration. For that future Codex integration, prefer codex-app-server: it has native turn/steer, live approvals and an owned process. Keep codex-sdk for simpler exec consumers, with its documented cancellation limitation. Do not pretend that concurrent run/start is steering.

## Shared versus provider-specific code

| Owner                               | Responsibility                                                                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deus/agnt product backend           | Durable inbox, ordering/batching, dispatch receipts, retry/restart reconciliation, workspace/Project policy                                             |
| AgentRuntime                        | One executing turn per logical session, duplicate request convergence, busy/closing guard, scoped cancellation, permission broker, normalized lifecycle |
| BaseAgent                           | Per-turn abort-controller ownership and external-signal cleanup                                                                                         |
| SessionStore / ChildProcessLifetime | Common Codex app-server/ACP resource tracking, removed-but-draining clients, actual exit and kill escalation                                            |
| Claude adapter                      | SDK prompt UUID/lifecycle correlation, public SDK interruption and process-exit observation; SDK owns its kill timer                                    |
| Codex adapters                      | Native exec/thread/start/interrupt and resume translation; SDK constraints remain explicit                                                              |
| ACP binding/adapter                 | Protocol error/approval mapping and native session/prompt/cancel translation                                                                            |

There is no duplicated durable queue per provider and no general workflow framework. The runtime enforces the invariant for embedded, native wire and ACP callers. Its completed-turn cache is only the latest 16 turns per session in one process; it is not durable exactly-once delivery.

## Confirmed findings fixed

1. Only the native JSON-RPC server rejected overlapping turns. Embedded runtime and ACP prompts could overlap and replace the provider's permission owner. Shared runtime admission now rejects before execution; idempotent retries still converge, and the next turn may start from the terminal callback.
2. Native wire also had the only closing-session guard. Embedded/ACP execution could begin while release was pending. The common runtime now blocks admission until release succeeds; repeated closes share a promise and failed close needs explicit retry.
3. Completed turns retained external abort bindings, and Claude retained its tap interrupt listener. A later abort could affect a warm successor. Both bindings now detach at their owning lifecycle boundary.
4. Codex app-server and ACP declared cancellation after logical close while their SIGTERM-ignoring processes still lived. Both share actual child-exit tracking and one bounded SIGKILL fallback; terminal/replacement waits for exit.
5. ACP's event sink awaited an unanswered human permission RPC, preventing the runtime broker from delivering cancellation. The response is now asynchronous; late answers cannot approve the successor.
6. Codex app-server swallowed all resume errors and started a fresh conversation. Fresh fallback now requires the exact requested missing rollout; auth, transient, model and wrong-thread failures remain visible.
7. Documentation incorrectly described embedded cancel as the wire result union and overstated queue redelivery guarantees. Runtime now accepts an optional turn stamp; guides distinguish the two response shapes, live cache scope, queueing and steering.

The earlier Claude fixes remain: interrupted failures classify correctly, resumed background terminal results cannot finish a submitted prompt, cancelled startup does not enqueue later, and queued prompt shutdown waits for actual SDK subprocess exit.

## Qualification

- Final upstream suite: **794 passed, nine conditional skips, 89 passing files**.
- Real provider checks: **six passed** — initial response and fresh-runtime conversation resume for Claude, Codex SDK and Codex app-server.
- Real pinned Claude CLI: two hook-blocked prompts completed on the same warm query with no replay/result UUID; this verifies why command lifecycle correlation is needed. Zero provider calls in that isolated hook exercise.
- Five actual SIGTERM-ignoring subprocess cases: Claude SDK escalation, plus Codex app-server and ACP during startup/active cancellation. No premature terminal before actual exit. A separate SDK case demonstrates its force-stop limitation and cleans the child explicitly.
- Real ACP client/server tests preserve the original approval when rejecting a concurrent prompt; cancelled unanswered approvals terminate, and late answers do not affect a successor.
- Shared regressions cover same-session rejection, independent-session parallelism, idempotent requests, terminal-callback admission, stale/wrong-harness cancellation, repeated/failing close, and external signal cleanup.
- Deus consuming the final patch: **1,140 backend tests and 88 agent-server tests passed** (seven conditional consumer skips), plus agent-server typecheck and bundle build.
- Fresh Bun frozen install in a new cache: **all 16 modified source files exactly match upstream**, unchanged lockfile, no local checkout dependency.

Upstream logs are under `thimphu/.context/engine-qualification/` and `thimphu/.context/codex-lifecycle/`. Deus logs are under `.context/project-smoke/engine-review-*`; patch reproduction is `.context/bun-patches/engine-review-final/verification.json`.

## Limits and next steps

The current Project scheduler explicitly selects Claude, and its seven Project tools are integrated through Claude MCP. The provider-independent queue design does not itself enable Codex Projects. Ordinary local workspace busy sends are rejected; only Projects currently persists a follow-up inbox, which can batch up to 16 inputs into one dispatch.

Native steering is deferred. A common API needs capability discovery, expectedTurnId, stable input IDs/retry receipts, transcript echo/correlation, and a clear outcome when completion or cancellation wins the race. Codex app-server can implement the first adapter; unsupported harnesses should say so explicitly.

Codex SDK has no public subprocess/force-kill hook. Its actual child ignores SIGTERM in our regression and the turn stays pending until external cleanup; the engine correctly retains ownership, but cannot guarantee a bounded stop. No private SDK methods were patched.

Claude qualification covers SDK 0.3.220/CLI 2.1.220 and Codex 0.153.4. It does not prove the entire permissive peer-version range, arbitrary detached descendants, remote VM shutdown, or complete provenance for independent native background model/tool work. Keep those boundaries explicit.

Changes remain in upstream source and a reproducible temporary Deus package patch. The release step is still to commit/review upstream, publish a version, update Deus, and remove the patch. No release or push was performed by this review.
