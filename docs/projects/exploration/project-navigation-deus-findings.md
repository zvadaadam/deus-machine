**Project navigation and live activity: current Deus fit**

Read-only source exploration, 14 September 2026. Recommendations below map the user-described Cursor Project layout—coordinator chat, Notes/Agents/PRs/Context and detail tabs—onto current Deus. No UI or schema was changed.

**Click an agent: open its existing workspace and exact conversation**

Yes. A Project agent should lead to the real execution context: its current conversation, checkout/branch, changes, files and runtime tools. It should not create another agent or another checkout merely because it was opened from a Project.

There is already a direct precedent: [AutomationDetail.tsx:82](../../../apps/web/src/features/automations/ui/AutomationDetail.tsx:82) resolves/adopts a run, receives `workspaceId` and `sessionId`, inserts/selects that exact session in the persisted chat-tab layout, and then selects the workspace. Opening only `workspaceId` is insufficient: a workspace can hold several chats, and its saved active tab can point at a different agent.

Reuse that resolution/adoption operation for Project member sessions, including cloud sessions without a local cache row. The caller supplies a stable typed session reference; an execution-context resolver supplies the current local UI workspace binding and provider workspace identity. A moved/replaced execution host must not require rewriting the Project's history.

[MainContent.tsx:417](../../../apps/web/src/app/layouts/MainContent.tsx:417) already renders WorkspaceHeader plus ChatArea. [content-tabs.ts:36](../../../apps/web/src/app/layouts/content-tabs.ts:36) registers Changes, Files, Terminal, Browser, Simulator, Apps and Agent configuration. [workspaceLayoutStore.ts:46](../../../apps/web/src/features/workspace/store/workspaceLayoutStore.ts:46) persists content-panel selection, open/active conversation IDs and other workspace view state. These are the detail surfaces to reuse.

**Keep Project context as navigation, not a physical workspace tree**

At Project level, show the coordinator conversation alongside Notes/Agents/PRs/Context. Agent selection opens the ordinary workspace detail inside the Project navigation context, with a compact `Project name › Agent name` breadcrumb and an immediate return to the Project's Agents panel. If top-level detail tabs are desired, each tab references an existing session/PR; it does not own another execution.

The header already has an automation provenance chip and a callback returning to its automation ([WorkspaceHeader.tsx:65](../../../apps/web/src/features/workspace/ui/WorkspaceHeader.tsx:65), [MainContent.tsx:425](../../../apps/web/src/app/layouts/MainContent.tsx:425)). A Project breadcrumb can reuse that principle. Preserve Project panel, selected detail and scroll/tab state separately from the workspace's own layout state, so returning restores the overview.

Treat the navigation target as Project ID + focused detail/session reference, rather than inferring the originating Project from the selected workspace. A workspace may contain unrelated sessions, and an adopted session might be shown in different collection contexts. Browser history/deep links should encode the selected Project and exact session. Current [workspace.tsx:22](../../../apps/web/src/app/routes/workspace.tsx:22) only synchronizes workspace selection; web-direct reflects it into `/w/:id`, while desktop/relay remain store-driven. Context-preserving detail navigation therefore requires a real navigation extension, not only another local boolean.

**Membership stays at the session level**

`project_sessions` is enough to find an agent's current workspace through the existing session relationship. Derive the set of distinct workspaces for overview display. A second `project_workspaces` table storing the same relationship introduces two sources of membership truth and can accidentally attach every unrelated chat in the same workspace.

Add explicit Project/workspace ownership only if the Project independently owns a resource: an integration checkout with no assigned session, a held environment retained across sessions, or cleanup rights. That association would answer a different question from agent membership. In particular, detaching a Project session must not archive a shared workspace containing other work. Visual nesting does not imply nested folders, nested Git worktrees or cascade-delete ownership.

**Track live agents through execution state, not chat tab selection**

Existing session details use WebSocket subscriptions ([session.queries.ts:59](../../../apps/web/src/features/session/api/session.queries.ts:59)); background tabs also subscribe independently ([session.queries.ts:81](../../../apps/web/src/features/session/api/session.queries.ts:81)). [query-engine.ts:188](../../../apps/backend/src/services/query-engine.ts:188) pushes snapshots and targeted deltas after invalidation.

Add a Project-scoped aggregate resource joining membership, assignments, session/turn state and actual environment availability in batches. Do not mount every transcript or launch a query chain per card to keep the overview current. Stream the selected transcript only when opened. Show current work, needs-response/error, queued/admitted execution and last activity; keep infrastructure availability distinct from task acceptance.

“Active” and “Recent” should be projections over those records, not durable categories copied from Cursor. Recent activity should use execution/message timestamps rather than arbitrary metadata updates. An event subscription is a persistent watch/trigger, not an agent secretly running forever; model and display it separately even if the Agents panel includes it.

**PR overview has reusable data but requires stronger collection tracking**

Deus stores one PR snapshot per workspace. [pr-snapshot.service.ts:6](../../../apps/backend/src/services/pr-snapshot.service.ts:6) refreshes it when the selected workspace requests status and when a session terminates, throttles/coalesces refreshes, and pushes the workspace resource when state changes. Cloud lookups can use repository URL plus branch ([pr-snapshot.service.ts:127](../../../apps/backend/src/services/pr-snapshot.service.ts:127)).

This is not complete live Project tracking: [workspace.queries.ts:255](../../../apps/web/src/features/workspace/api/workspace.queries.ts:255) polls the open workspace every 30 seconds while working and 60 seconds while CI is pending. A Project owner needs SCM updates/reconciliation independent of whichever row the human selected, then one aggregate push to the client. Extend the existing refresh service locally; cloud operation needs the corresponding cloud-authoritative path. Do not start a frontend polling loop per Project card.

Start the overview by aggregating associated workspace snapshots, deduplicated by SCM provider + repository identity + PR number. Capture durable Project/result-to-PR associations when discovered/accepted so a PR does not disappear because its session was detached or execution workspace removed. This relation also supports an adopted external PR and multiple PRs per agent; current one-PR-per-workspace columns alone do not.

Current [PRActions.tsx:180](../../../apps/web/src/features/workspace/ui/PRActions.tsx:180) opens the PR in an external browser. There is no reusable internal PR-detail tab here. The smallest honest flow is a Project PR card with status/review/checks, **Open on GitHub**, and **Open agent / View changes**. A proper PR detail view is new work: a workspace's current uncommitted/branch diff is not necessarily the PR's actual reviewed diff. Preserve that distinction if building Cursor-like detail tabs.

**Cloud drill-down is partly present, not complete**

The direct-web adapter currently represents each cloud session as a synthetic workspace row whose UI ID equals session ID; the real `provider_workspace_id` is separate ([cloudDataAdapter.ts:197](../../../apps/web/src/features/session/cloud/cloudDataAdapter.ts:197)). Project relationships must use real typed session/workspace identities, not perpetuate that presentation shortcut.

Fully Mac-independent web currently hides every workspace content tab ([content-tabs.ts:64](../../../apps/web/src/app/layouts/content-tabs.ts:64)). Chat is usable, but full Files/Changes/Terminal detail there needs API/capability work. Opening the agent transcript should not itself wake an asleep VM; runtime-dependent operations should expose actual availability and wake deliberately. This lets Project overview/history/PRs remain useful while execution environments are asleep or gone.
