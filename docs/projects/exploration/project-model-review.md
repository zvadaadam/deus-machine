**Independent challenge of the proposed Project model**

The earlier proposal is too ready to turn every responsibility into a Project-prefixed SQL table. The stronger foundation is a persistent body of work, a versioned file namespace, ordinary sessions associated with it, and a recoverable orchestration service. Those concepts can run locally or on a server. SQL tables, object stores and queues are implementation choices beneath them.

This is an architectural recommendation from the current Deus schema and the installed-Cursor research, not Cursor's private database design. In particular, `project_deliveries` was our proposed recovery mechanism. The inspected Cursor client has worker-membership contracts, stable creation IDs, a bounded completion ledger and store synchronization; that does not establish a server table called deliveries.

**The smallest useful domain vocabulary**

| Concept                | Identity and lifetime                                                                                                 | Source of truth                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Project                | The durable goal/context and associated work; survives model, coordinator, machine and checkout replacement           | Project service metadata and versioned content                                 |
| Session                | Existing persistent conversation, transcript, provider resume identity and successive turns                           | Existing session/turn model                                                    |
| Agent                  | Product-language actor doing work; currently represented by a session using an agent harness                          | Do not create another persistent identity without a lifecycle requiring it     |
| Task                   | A desired result plus acceptance criteria; can outlive several attempts                                               | A task document for content; explicit assignment/outcome records for execution |
| Attempt                | One accepted assignment to a session; may include several engine turns and can succeed, fail, cancel or be superseded | Recoverable orchestration records                                              |
| Environment            | Reusable recipe/capabilities needed to execute                                                                        | Existing platform environment                                                  |
| Workspace/checkout     | Concrete mutable code state and branch on a computer                                                                  | Existing workspace/provider records; Git for code history                      |
| Project files          | Brief, decisions, task instructions, notes and result artifacts                                                       | One versioned content namespace, materialized as ordinary files                |
| Command/event delivery | Moving accepted work and observed outcomes between components                                                         | Orchestration implementation, not an agent-authored task checkbox              |

Use **Agents** in the product and **`project_sessions`** for the membership table today. Deus already persists the relevant identity in `sessions`; `agent_harness` names its execution adapter. A new `project_agents` table suggests a separate durable actor with a lifecycle not yet present. “Worker” can describe a contributor's current role without becoming the permanent database name.

Membership and management should remain separate from creation lineage. An adopted conversation still has its original creator. A task can move to another session. If `projects.coordinator_session_id` selects the current coordinator, do not also persist a competing coordinator flag in membership; derive that role from the pointer. Enforce that the selected session belongs to the Project. Retain prior assignment history only when needed, rather than inventing a persistent agent/persona layer now.

**Documents should be real files with a deliberate publishing boundary**

Yes: a Project should have a recognizable directory, for example `brief.md`, `decisions/`, `tasks/`, and `results/<attempt-id>/`. It must be independent of any worker's Git checkout. A worktree-local `.context` cannot be the shared authority for several repositories and disappears or diverges when checkouts change.

The previous recommendation to store document bodies in SQL and generate Markdown exports puts the ordinary agent filesystem workflow behind custom tools. Prefer canonical document bytes in the versioned file namespace. SQL can own its path/revision/content-hash index and references. Search text or parsed board records are explicitly rebuildable projections. Avoid duplicating a goal as independently editable `projects.objective` and `brief.md` text.

However, a canonical shared folder with arbitrary writers is not enough. One owning backend or VM does not mean one author: a coordinator, a contributor and a human can all edit the same file. A file watcher cannot retroactively make overwrites revision checked. Native edits can also produce partial files before the writer finishes.

The smallest credible design uses **materialized drafts and explicit publish**:

1. Give an agent an ordinary folder materialized from a particular Project revision. Its native tools can read and edit files normally. That folder is its draft, not a second authority.
2. Publish a bounded change set against its base revision. The owner checks the revision and allowed paths, records the new content revision, and preserves the draft if publication conflicts.
3. Human edits use the same revision boundary. A saved human edit cannot silently be overwritten by the coordinator's older draft.
4. Contributors start with a snapshot of shared context and normally publish under their own result/attempt directory. The coordinator incorporates accepted results into shared decisions and plans. Whole-folder bidirectional synchronization is unnecessary.
5. Re-materialize at clear boundaries, such as dispatch and turn start. Record the context revision used by an attempt so stale context is visible and retries are explainable.

The first prototype can serialize publication and allow only the coordinator/human to change shared files, with contributors publishing independent results. That is a real scope restriction, not a claim that arbitrary concurrent native edits are safe. It also does not require a CRDT, live shared POSIX filesystem, universal merge engine or Git push for every keystroke.

A local directory can be the authoritative backing store for this namespace now, with retained revisions. In cloud operation a durable content service can store blobs and a versioned manifest, while execution environments receive ordinary materialized folders. An object bucket alone is not a coherent filesystem mount. The client contract is revisioned read/materialize/publish; the backing implementation changes without changing how a Project is understood.

**Keep operational truth outside documents**

A task can say “done” while a launch is still running, or while its changes failed verification. Model the accepted assignment and its lifecycle independently. The attempt records the task ID or instruction reference, target session, stable dispatch identity and final outcome. Reference artifact revisions and code commits when accepting results.

Store referenced content durably before acknowledging the database transition which points to it. A crash may leave an unreferenced content revision; reconcile or collect it later. Never acknowledge an accepted result that only exists on an ephemeral worker disk. Durable command acceptance plus retry-safe dispatch is necessary; naming a table `project_deliveries` does not supply those guarantees.

Do not begin with a generic event-sourcing framework. Reuse platform scheduling/admission primitives where they actually provide the needed semantics, and add a narrow command journal/outbox where missing. Stable command IDs, deduplicated completion handling and reconcilable attempt state matter more than making the transport a visible domain object.

**Three strongest hidden risks**

1. **Content split between SQL, files and machines.** A table-plus-export design creates two editable versions; a shared writable folder creates lost updates; an ephemeral VM folder creates data loss. Correct boundary: one versioned content authority, drafts in execution environments, revision-checked publication and rebuildable indexes.
2. **Project identity coupled to a session, primary repository or computer.** Existing sessions require workspaces, and workspaces require repositories. Treating that as the permanent Project model forces the coordinator to “belong” to an arbitrary code checkout and makes cloud replacement painful. Correct boundary: independent Project identity, explicit session membership and execution placement. A temporary primary-repository coordinator is an experiment shortcut that needs labeling, not a durable ownership rule.
3. **A domain table list pretending to be cloud orchestration.** Membership, logical tasks, execution attempts, per-turn outcomes and message transport have different lifetimes. Combining them in `project_workers`/`project_deliveries` encourages duplicate launches and incorrect completion while a custom local scheduler creates a later rewrite. Correct boundary: a hostable orchestration service whose owner persists accepted operations and reconciles executions; agents propose actions, the service owns lifecycle and recovery.

The existing cloud-only automation design is a useful precedent: the platform executes and owns the ledger, and Deus caches it (`docs/automations-plan.md:9`; `shared/schema.ts:267`). A local Project can initially be owned by the local service, but a cloud Project must move its authority, content and wakeup/recovery scheduling to the cloud together. A laptop-hosted manager with cloud contributors is an intermediate mode. Avoid concurrent local/cloud ownership during handoff; immutable Project IDs and revisioned operations make a deliberate handoff possible.

Evidence read: `.context/cursor-projects-data-model.md`; `shared/schema.ts:120` (repositories), `:131` (workspaces), `:161` (sessions), `:201` (turns), `:267` (automation cache); `apps/backend/src/services/agent/commands.ts:365` (session/harness and local/cloud dispatch); `apps/agent-server/agents/core/engine.ts:31` (harness registration and Deus tool bridge); `docs/automations-plan.md:9` (current cloud authority decision). This is source analysis only, with no implementation or live execution.
