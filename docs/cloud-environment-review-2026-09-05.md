# Cloud environment review — 2026-09-05

The architecture is heading in the right direction, but several lifecycle gaps prevent the current cloud experience from being reliably interchangeable with local work. The highest priorities are preserving work, making Stop/Archive truthful, and reconciling conversations when people switch devices. Keep the three-repository split and fix the ownership boundaries described below.

Reviewed the current checkouts: Deus `df40aaf600` (through #329/#330), AGNT `eefc1fa2` (through #180), and agent-server `6207d7f`. This covers creation and environment setup, credentials, agent execution, reconnects, persistence/recovery, archive, hosted devices/builds, and the desktop/browser product paths. It includes the cloud-workspaces and node-mesh plans and recent PR intent. The review is broader than the empty task-branch diff.

This review records the baseline before implementation. Subsequent code changes and disposable provider tests are documented in [implementation results](cloud-reliability-results-2026-09-05.md). Product observations below come from the implemented flows and copy; this was not a fresh visual usability test or live EAS smoke test. Reproduction scripts and detailed supporting reviews are in [.context/cloud-review](/Users/zvada/conductor/workspaces/deus-machine/sao-tome/.context/cloud-review).

The follow-up [implementation plan](cloud-reliability-plan-2026-09-05.md) gives the concrete sequence, preparation refactors, acceptance tests and eight delivered Hivenet reports. It also clarifies pause semantics: E2B retains paused machines indefinitely; the dangerous replacement paths are in our own error handling, not routine paused-machine expiration. [E2B persistence](https://docs.e2b.dev/sandbox/persistence)

**The ownership model to keep**

| Layer                       | Responsibility                                                                   |
| --------------------------- | -------------------------------------------------------------------------------- |
| Deus Machine                | Product UI, local execution, and projections of cloud state                      |
| AGNT `apps/deus-cloud`      | Product identity, organization policy, GitHub integration and credential minting |
| AGNT backend + Workspace DO | Cloud computer lifecycle, recovery, resource ownership and cleanup               |
| AGNT sidecar                | Agent execution and device/file operations beside the project                    |
| agent-server                | Generic harness lifecycle and canonical agent protocol                           |

All consumers checked pin agent-server `0.3.2`; Deus uses API/SDK `1.4.0`. The canonical event protocol, source-shipped engine, exact pins, and tolerant cloud status readers are valuable. The confirmed execution problem below belongs in the sidecar's preparation lifecycle, not in the generic engine. The platform-only Expo credential decision in AGNT #176 is also a useful simplification.

**Confirmed reliability findings**

**Follow-up finding — Retryable connectivity failures can destroy a resumable machine.** [Pause errors fall back to termination](/Users/zvada/conductor/workspaces/agnt/tbilisi/apps/backend/src/workspace/do/workspace.ts:1328); [resume/connect errors](/Users/zvada/conductor/workspaces/agnt/tbilisi/apps/backend/src/workspace/do/workspace.ts:1372), heartbeat timeout and sidecar reconnect timeout can enqueue full reprovision. The [queue consumer kills the previous VM](/Users/zvada/conductor/workspaces/agnt/tbilisi/apps/backend/src/workspace/provisioning.ts:100) before creating its replacement. Preserve sandbox identity through transient errors; distinguish confirmed absence from unavailable/unauthorized, and reserve replacement for actual loss or explicit reset. This makes the recovery bug below reachable even when the existing machine still holds the work. These paths were source-confirmed; no live VM failure was injected.

1. **P1 — Cold reprovision can overwrite the saved work it should recover.**

   The [clone step](/Users/zvada/conductor/workspaces/agnt/tbilisi/apps/backend/src/workspace/steps/repo-clone.ts:24) checks out the origin branch, falling back to its base. It never reads `refs/agnt/wip/<workspaceId>`. The next [autosave force-pushes](/Users/zvada/conductor/workspaces/agnt/tbilisi/apps/sidecar/src/utils/git-sync.ts:296) the recreated checkout over that same ref. The separate [R2 restore](/Users/zvada/conductor/workspaces/agnt/tbilisi/apps/backend/src/workspace/steps/restore-snapshot.ts:5) restores Claude session files, not the project.

   **Trigger:** Work is saved to the WIP ref but not published on the branch; the VM is lost/stopped and the platform provisions a replacement. This does not describe an ordinary successful E2B pause/resume, which retains the disk.

   **Reproduced:** With the real clone and autosave functions and a local bare Git origin, `valuable cloud work` was saved successfully. Reprovision returned `original`; the next autosave changed the recovery ref to `original` too. The previous object may remain reachable by a separately retained SHA, but the advertised recovery ref no longer protects it.

   **Fix:** Restore the workspace's saved Git state before admitting another turn. Retain the last confirmed recovery SHA and prevent a fresh checkout from replacing an unreconciled recovery ref. Add a recovery action and expose save failures. Preserve recovery data through archive until an explicit retention/deletion policy applies.

2. **P1 — The actual Archive button does not stop the cloud workspace.**

   [WorkspaceService.archive](/Users/zvada/conductor/workspaces/deus-machine/sao-tome/apps/web/src/features/workspace/api/workspace.service.ts:118) sends `q:archiveWorkspace`. Its [mutation handler](/Users/zvada/conductor/workspaces/deus-machine/sao-tome/apps/backend/src/services/query-engine.ts:493) stops local AAP apps and updates SQLite. Cloud shutdown exists only in the separate [PATCH handler](/Users/zvada/conductor/workspaces/deus-machine/sao-tome/apps/backend/src/routes/workspaces.ts:132).

   **Impact:** The workspace disappears from the UI while its cloud agent, VM, or device can continue working and accruing usage until another lifecycle mechanism stops it.

   **Fix:** One archive service must serve both transports, cancel the workspace's turns, stop hosted devices, pause its VM, and preserve recovery data for unarchive. Persist the suspension intent in the cloud and report pending/failed cleanup. Do not simply delegate to the current PATCH implementation: it kills the VM and deletes the WIP ref without checking whether work was published or recovered. Test the actual UI mutation and stale preview traffic: the current provider's `autoResume: true` means a pause alone does not guarantee the archived computer stays paused. [E2B auto-resume](https://docs.e2b.dev/sandbox/auto-resume)

3. **P1 — Reopening the desktop misses conversation history written while it was away.**

   The default desktop [snapshot handler](/Users/zvada/conductor/workspaces/deus-machine/sao-tome/apps/backend/src/services/agent/cloud/driver.ts:430) only synthesizes a missed `turn.ended` for a turn it already knows. It ignores snapshot messages. [Direct rendering remains opt-in on desktop](/Users/zvada/conductor/workspaces/deus-machine/sao-tome/apps/web/src/features/session/cloud/cloudDirectFlag.ts:18); the browser's existing snapshot fold therefore does not repair the default desktop transcript.

   **Reproduced:** The unchanged driver received a snapshot containing a browser-written message. With no local live turn it emitted zero fold events; with a matching local turn it emitted only `turn.ended`. A live message frame passed the positive control.

   **Fix:** Reconcile authoritative cloud snapshots into the desktop conversation projection using stable message/part/turn identifiers. Keep this in the existing fold/persistence path. Test desktop → browser turn → desktop, a dropped connection during streaming, and repeated snapshots without duplicate text or usage.

4. **P1 — Cancelling during preparation can acknowledge Stop and then run the agent.**

   The [sidecar controller](/Users/zvada/conductor/workspaces/agnt/tbilisi/apps/sidecar/src/agents/controller.ts:409) awaits Git checkpoint capture and credential preparation before `runtime.run()`. [Cancel](/Users/zvada/conductor/workspaces/agnt/tbilisi/apps/sidecar/src/agents/controller.ts:128) only asks the engine to cancel. An engine with no admitted turn correctly answers that it is idle, but the sidecar does not cancel its own pending preparation.

   **Reproduced:** Holding checkpoint capture, then cancelling, produced `idle` with zero runs. Releasing the checkpoint subsequently produced `running` and `completed`, with one engine run.

   **Fix:** The sidecar must own cancellation from execute receipt through preparation and execution. Record cancellation against the admitted turn, check it after preparation awaits, and release staged credentials when preparation is cancelled. Keep the engine responsible for cancelling a turn once it actually owns it.

5. **P1 — Failed hosted-device stops have no durable retry after pause/delete.**

   The [Workspace sweep](/Users/zvada/conductor/workspaces/agnt/tbilisi/apps/backend/src/workspace/simulator-sessions.ts:295) retains failed stops for the next workspace transition. A parked workspace need not transition again, and [deletion clears its alarm](/Users/zvada/conductor/workspaces/agnt/tbilisi/apps/backend/src/workspace/do/workspace.ts:790). The active sidecar also [removes a device from its map before stop succeeds](/Users/zvada/conductor/workspaces/agnt/tbilisi/apps/sidecar/src/simulator/manager.ts:967), so repeating Stop need not retry that device.

   **Impact:** A temporary provider failure can leave a billed device until the provider's own idle/duration backstop. This is avoidable billing, not a claim of infinite billing.

   **Fix:** Persist stop intent with the Workspace's device ledger and schedule cleanup independently of VM heartbeat/provisioning. Cleanup must continue for paused/deleted workspaces without restarting them. Stop should remain addressable until confirmed terminal. Test failure → parked/deleted → alarm retry → confirmed cleanup.

6. **P1 — Device reconciliation can hide a newly started, billed device.**

   [Reconciliation](/Users/zvada/conductor/workspaces/agnt/tbilisi/apps/sidecar/src/simulator/manager.ts:666) checks local ownership, awaits a provider poll, then adopts the result without rechecking. [Start](/Users/zvada/conductor/workspaces/agnt/tbilisi/apps/sidecar/src/simulator/manager.ts:365) can create a device during that await.

   **Reproduced with the real manager and a synthetic broker:** Hold the poll of an old ledgered device; start a new device; release the old poll. The visible device changed from new to old, while both remained ledgered and neither received Stop. A surviving device after a failed cleanup makes this reachable during reconnect recovery.

   **Fix:** Start and reconciliation must share per-platform admission and operation ownership. Recheck ownership after provider awaits, and explicitly resolve an extra resource instead of silently overwriting its slot.

7. **P2 — Cancelling a device boot reports failure after successfully stopping it.**

   [Stop](/Users/zvada/conductor/workspaces/agnt/tbilisi/apps/sidecar/src/simulator/manager.ts:952) stops the boot's provider id; [the boot's catch path](/Users/zvada/conductor/workspaces/agnt/tbilisi/apps/sidecar/src/simulator/manager.ts:511) stops it again. The [real broker](/Users/zvada/conductor/workspaces/agnt/tbilisi/apps/backend/src/workspace/simulator-sessions.ts:127) has removed the successful first stop from its ledger, so it rejects the second as not live.

   **Reproduced:** `create → poll → stop → stop`, empty ledger, final status `error: cancelled, but the stop failed`. Existing manager fakes always accept Stop and miss the mismatch.

   **Fix:** Share one teardown result between Stop and the boot handle. Alternatively retain workspace-owned terminal receipts for idempotent Stop; keep rejecting arbitrary foreign device ids.

8. **P1 for App-token private repos — Git credential renewal still depends on the Mac.**

   The browser sends directly to AGNT, whose turn dispatch resolves model credentials but does not mint GitHub access. [Resume rewrites the stored token](/Users/zvada/conductor/workspaces/agnt/tbilisi/apps/backend/src/workspace/do/workspace.ts:1386), assuming the integrator refreshed it first. A Mac-closed resume after expiry therefore restores an expired token; a replacement VM can fail its private clone. In an already-running VM, [desktop sends skip renewal](/Users/zvada/conductor/workspaces/deus-machine/sao-tome/apps/backend/src/services/agent/commands.ts:555), and updating DO secrets does not update the live Git auth files.

   **Impact:** Git fetch/push, PR operations and autosave can fail after the App token's one-hour lifetime while agent chat still works. Public/PAT-only setups can conceal this. These paths are code-confirmed; an actual expired-token cloud experiment was not run.

   **Fix:** Keep repository policy and minting in deus-cloud, and let the platform obtain fresh credential leases through a trusted generic provider binding before clone/resume and near expiry while running. Renew both Git and `gh` auth files. Separate renewal from workspace creation and environment secrets. Surface failed autosaves. The plan acknowledges internal reprovision renewal as unfinished; #330 and open #331 do not complete this Mac-closed/live-VM path.

**Product and maintainability improvements**

- **Complete the workspace's authority over device state.** Devices belong to a computer, but status is mirrored in individual AgentSession histories. AGNT #180 fixes per-platform mirrors, not this scope mismatch. A new chat/cold read can lack the history of a running device. Deus compensates with old-session fallbacks, per-session pruning and caches. Give Workspace a per-platform status snapshot and revision, forwarded over the existing sockets. This is the natural home for the cleanup and admission fixes above. It should simplify the consumer code materially.

- **Make cloud setup complete and unambiguous.** [The cloud card](/Users/zvada/conductor/workspaces/deus-machine/sao-tome/apps/web/src/features/settings/ui/sections/CloudEnvironmentBlock.tsx:59) labels recipe existence as Configured and lists `requiredEnv` names, but provides no cloud secret-value inputs. The nearby [Environment variables editor](/Users/zvada/conductor/workspaces/deus-machine/sao-tome/apps/web/src/features/settings/ui/sections/EnvironmentSection.tsx:367) writes local `deus.json`. Meanwhile the agent's tool tells the person to set required values in Settings. Add a clearly scoped cloud secrets action and distinguish recipe saved, missing values, verified setup, and lookup unavailable. Label the local configuration separately. Reconfiguration should be reachable directly from a setup failure.

- **State the real browser capability boundary.** The browser intentionally [hides every content tab](/Users/zvada/conductor/workspaces/deus-machine/sao-tome/apps/web/src/app/layouts/content-tabs.ts:100) and [cannot create new sessions](/Users/zvada/conductor/workspaces/deus-machine/sao-tome/apps/web/src/features/repository/ui/HomeView.tsx:991). It can continue cloud chats with the Mac closed; it is not yet the complete cloud IDE. Before enabling devices/files/terminal there, stop presenting each chat as a separate [synthetic workspace](/Users/zvada/conductor/workspaces/deus-machine/sao-tome/apps/web/src/features/session/cloud/cloudDataAdapter.ts:204). Use the real provider workspace identity, then supply typed direct-socket operations through the existing resource seams. Maintain one tested capability table for local desktop, desktop cloud, relay web and direct web.

- **Distinguish devices from native builds.** Hosted iOS and Android devices exist, but [managed builds reject Android](/Users/zvada/conductor/workspaces/agnt/tbilisi/apps/backend/src/agent-session/eas-build-broker.ts:91). Android can install an existing APK; automatic Android build/run is unfinished. This is an AGNT build-lane gap: Expo documents debug APK builds with `withoutCredentials` and `:app:assembleDebug`, so customer release-keystore management is not a blanket prerequisite. The actual managed provider payload still needs validation. [Expo configuration](https://docs.expo.dev/build/eas-json/) The simulator UI should expose which platform and build actions are supported. “Build and run” should report build progress, installation and launch separately from merely booting a device. Include a platform selector and show all active devices, since the backend can own both at once.

- **Include the selected harness in capability discovery.** Claude and Codex can both execute cloud turns, but [Codex's internal MCP/hook bridge is still absent](/Users/zvada/conductor/workspaces/agnt/tbilisi/apps/sidecar/src/agents/engine.ts:395). The [upstream Codex app-server adapter also advertises `mcpServers: false`](/Users/zvada/conductor/workspaces/deus-machine/sao-tome/node_modules/@zvada/agent-server/src/core/agents/codex-app-server/codex-app-server-agent.ts:30): generic configuration support belongs upstream, then AGNT can connect its existing internal tool server. Environment setup already requires Claude; carry that distinction into agent-facing capabilities and relevant UI actions until the bridge exists. Human Simulator controls use a separate harness-independent path. This is documented missing support, not an agent-server regression; MCP parity alone does not implement Claude-native hooks.

- **Make build failures diagnosable and reproducible.** Carry provider error code/phase and a bounded log tail; this is already a follow-up from AGNT #175. Record toolchain/recipe identity with the artifact and reuse key: [the managed job selects `latest`](/Users/zvada/conductor/workspaces/agnt/tbilisi/packages/shared/src/eas-protocol.ts:396), so matching source content alone does not identify every build input. Keep the shared packaging/hash manifest and ownership checks. Expo currently labels its remote simulator commands experimental, which supports an explicit tested provider compatibility policy. [Official EAS CLI reference](https://docs.expo.dev/eas/cli/).

- **Replace the plans' competing status narratives with a current capability ledger.** Keep historical decisions as history and put shipped/partial/missing state first. The cloud plan still calls preview unstarted and merged web fixes in flight; node-mesh still describes direct mode as future work. The main README's [all-data-local description](/Users/zvada/conductor/workspaces/deus-machine/sao-tome/README.md:162) also predates cloud storage. The referenced code-style skill is missing in this checkout. These inconsistencies make both humans and agents re-derive the architecture. Update the relevant design states alongside subsequent UI work; the encrypted Pencil document itself was not inspected in this review.

**Suggested delivery order**

| Work package                                   | Main owner                                               | Acceptance evidence                                                                                                                           |
| ---------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Preserve the VM and restore saved Git work     | AGNT, then Deus recovery surface                         | Transient error never kills/recreates; real Git: autosave → confirmed VM loss → reprovision → same files; no recovery-ref clobber             |
| Make Archive and agent Stop truthful           | Deus archive service; AGNT controller                    | Actual `q:archiveWorkspace` cancels work, stops devices, pauses the VM and retains recovery; cancel during preparation never calls the engine |
| Make device lifecycle authoritative            | AGNT Workspace + sidecar, then Deus cache simplification | Failed stop retries after deletion; concurrent reconnect/Start owns one device; cancelled boot ends stopped                                   |
| Complete continuity and renewal                | Deus projection + deus-cloud/AGNT credential seam        | Desktop → browser → desktop transcript equality; private-repo Git works after token expiry with Mac absent                                    |
| Finish environment readiness and capability UI | Deus + narrow platform endpoints                         | A new person can identify missing secrets, supply them, recover setup, and tell supported devices/builds apart                                |
| Expand direct-web operations                   | Deus + AGNT product auth endpoints                       | Create/continue/inspect/stop from browser using actual workspace identity; capability matrix enforced                                         |

Each package can be split into small PRs at repository boundaries. Stabilize contracts before extracting modules. In particular, a large manager or driver file is not itself the problem: multiple independent owners of preparation, archive and device lifecycle are what produced the concrete failures.

**Validation performed**

- Deus selected backend cloud/node tests: **135 passed in 11 files**.
- Deus selected frontend/desktop cloud tests: **152 passed in 17 files**.
- `bun run typecheck` and `bun run typecheck:backend`: **passed**.
- Real Git reproduction of lost WIP recovery: executed and independently rerun.
- Unchanged-source probes of desktop snapshot handling and preparation cancellation: executed and independently rerun, with dependency stubs and a live-frame positive control.
- Real simulator-manager probes with synthetic provider brokers: reconciliation/Start race and boot double-stop reproduced without cloud calls.

The green unit suites do not cover these cross-component guarantees. Add the specific regressions above, then keep a small authenticated staging smoke for private-repo creation, Claude/Codex execution, a native simulator build/install/run, browser handoff and confirmed resource cleanup. Historical PR smoke reports are useful context; they are not fresh evidence that this checkout's deployed cloud path works end to end.
