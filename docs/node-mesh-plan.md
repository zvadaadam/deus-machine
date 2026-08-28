# Node Mesh — architecture & build plan

_Drafted 2026-08-27. This is the durable north-star for turning "local + cloud"
into a **node mesh**: a model where a workspace, a session, a file tree, a
terminal — any resource — is reachable the same way whether it lives on your
Mac, in your cloud, or (later) on a teammate's machine. One address scheme, one
wire, one projection._

**Status: Phases 0–2 shipped (backend); the communication style is in place for
cloud + local and ready for future nodes.** Near-term product need is only **your
local + your cloud, one user**. The mesh is the north star that shapes how we
build that near-term slice so the teammate mesh is a clean _extension_, not a
rewrite. Nothing here asks us to build the teammate mesh now — it asks us to not
_foreclose_ it. The interactive companion to this doc lives at
`.context/research/mesh-architecture.html`; the shipped cloud model it builds on
is `docs/cloud-workspaces-plan.md`.

## Adding a future node (the seam is ready)

Because live resources route through the driver interface and state routes
through the source-agnostic fold, a new node — a second Mac, a teammate's
machine, a second cloud region — plugs in without touching call sites:

1. **Give it a `NodeId`** (`services/node/index.ts`). Today `"local"` / `"cloud"`;
   a peer becomes `"peer:<pubkey-hash>"` — `NodeId` is opaque and derived exactly
   so this doesn't ripple.
2. **State resources**: point its event stream at the shared
   `AgentEventHandler.handle` (the fold is proven _source-agnostic_ — see the
   contract test). Its workspaces/sessions/messages then fold in locally — once
   session IDs are node-unique or the fold key is node-qualified (see State,
   above), so two nodes can't collide on a shared session ID.
3. **Live-probe resources**: implement `NodeDriver` (diff + fs) for it and add a
   case to `resolveNode`. Streams (pty) implement the `ptyRouter` shape.
4. **Reach + trust** (only for a node you don't already own): a discovery entry
   and a signed capability grant — the one genuinely new build, deferred until a
   teammate node is real (see Trust, below).

Steps 1–3 are the pattern this PR establishes; nothing about them is
cloud-specific. That is what "ready for future nodes" means here.

---

## The thesis

**One protocol. Every node speaks it. The client federates them.**

A _node_ is anything that hosts resources and speaks the wire: your Mac's
backend, your cloud (agnt's `AgentSession` DO + E2B sidecar), later a teammate's
machine. A _resource_ is addressed by a **`ResourceRef` = (node, kind, id)**.
Verbs (`open`, `send`, `event`, `replay`, `close`) act on refs. That's the whole
model; everything below is how it grounds in code we already run.

The reason this is buildable and not a rewrite: **three of the four layers a
mesh resource protocol needs already exist and are load-bearing in production.**
We are generalizing a spine that works, not inventing one.

---

## What already exists (verified by direct inspection)

| Layer                                                                                  | Where it lives today                                                                                                                                                                    | Status for the mesh                                                                                              |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Transport** — duplex NDJSON line channel, resource-blind, already Workers-compatible | `@zvada/agent-server` `protocol/wire.ts` (`WireTransport` + `channelTransport`)                                                                                                         | Reuse verbatim                                                                                                   |
| **Replay** — per-key monotonic seq + ring buffer + gap-heal                            | `server/session-log.ts` (`SessionLog`) + `protocol/seq-cursor.ts` (`SeqCursor`, its doc already anticipates "a DO replaying a log")                                                     | Reuse; re-key from `sessionId` to `(kind,id)`                                                                    |
| **Fold** — node-agnostic event sink; uses only `envelope.sessionId` + `envelope.event` | `apps/backend/src/services/agent/event-handler.ts` (`AgentEventHandler.handle`), wired in `service.ts`                                                                                  | **Already fed by two transports from one handler** ("one fold, one persistence path, two transports"); make it N |
| **Dispatch** — route a live request to the node that owns the resource                 | ~10 hand-written `workspace.kind === "cloud"` branches across `routes/workspaces.ts`, `workspaces.diff.ts`, `files.ts`, `services/pr-snapshot.service.ts`, `services/agent/commands.ts` | **The one real refactor.** No interface, no registry today                                                       |

The tell that this is the right shape: **agnt, handed the entire engine, kept the
transport, the protocol vocabulary, and the seq/replay idea — and threw the
agent-turn wire away**, reimplementing multiplex/replay/admission around a DO
that hosts fs+pty+diff+browser alongside agent turns. The mesh follows that
instinct: keep the substrate, drop the agent-turn surface.

### Two resource classes — only one is ever "remote" at read time

This is the fact that makes federation cheap:

- **State** (`workspaces`, `sessions`, `messages`, `stats`) is **event-sourced
  into local SQLite**. A node emits lifecycle events; the fold writes rows; the
  UI reads rows. The read is always local — remoteness is invisible to it. This
  is _already true_ for cloud sessions today, via the shared fold. A third node
  emitting the same envelope shape folds the same way — **with one caveat**:
  `handle` keys purely on `sessionId`, so this is _source-agnostic_ handling, not
  yet _collision-safe_ identity. True multi-node sharing needs either
  globally-unique session IDs across nodes or a node-qualified fold/persistence
  key (a `nodeId` on the envelope); otherwise two nodes reusing a session ID
  would merge in local persistence and invalidation. Adding that key is the
  cheap-early move (prior-art invariant 2), not a rewrite.
- **Live-probes** (diff summary/file, fs tree/read, pty) **can't** be
  event-sourced ahead of time and are fetched per request from the owning node.
  These — and only these — are the `kind === "cloud"` branches. Example, from
  `routes/workspaces.diff.ts`: `if (workspace.kind === "cloud")` →
  `getCloudDiffSummary(current_session_id)`, else `gitService.getDiffStats(path)`.

State federates by event-sourcing; live-probes federate by owning-node dispatch.
Keep the two mechanisms distinct — conflating them is how this gets muddy.

### Single writer — why we never need CRDTs

`docs/cloud-workspaces-plan.md` already settled it: _"there is exactly one writer
at any moment."_ Each resource is owned and written by exactly one node (a
session lives where its worktree/sandbox is). A teammate **reads** your session
or opens **their own** — they never co-author your log. So the entire class of
multi-writer merge machinery (CRDTs, Automerge/Yjs, Matrix-style state
resolution) is **out of scope by construction**, forever. Guard this invariant;
it is what keeps the fold simple through the whole teammate mesh.

---

## Prior-art triangulation (how proven systems do this)

Every system that federated gracefully baked in a few cheap invariants _early_
and deferred everything else. The lessons are strikingly consistent, and they
map directly onto Deus's one known expensive-to-retrofit edge (the untagged
event bus).

| System                                | Mechanism worth stealing                                                                                                                        | Lesson for Deus                                                                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Tailscale**                         | Each node = a keypair; coordination server maps keys→tailnet; DERP relays, nodes dial **out** (NAT traversal); data never through control plane | Self-certifying node identity; **we already dial-out through a blind relay** — reach is solved                                     |
| **Syncthing**                         | Device ID = hash of the node's cert public key; exchange IDs out of band                                                                        | Identity = a key, verifiable by anyone, no central authority                                                                       |
| **Matrix**                            | Every ID is server-qualified (`@u:server`, `!room:server`); events carry `origin`                                                               | **Namespace every identifier by its node from day one, even with one node** — the ones that used bare local IDs paid in migrations |
| **AT Protocol (Bluesky)**             | DID → doc with signing keys + data-server endpoint; repos are signed; OAuth scopes for 3rd-party read                                           | Portable key-backed identity + scoped grants = "read someone else's repo"                                                          |
| **SSH certificates**                  | A CA signs "this key may act as X on Y until Z"; verified offline against the CA's public key; attenuable                                       | The teammate grant is an SSH cert. Offline-verifiable against a published key                                                      |
| **Macaroons / biscuit / UCAN**        | Signed, scoped, **attenuable**, offline-verifiable capability tokens                                                                            | The capability layer has a spec'd, shipping shape to copy                                                                          |
| **Local-first (Replicache / Linear)** | Server-authoritative log + client projection; client folds a mutation stream                                                                    | Our fold is this pattern; keep reading from the projection                                                                         |
| **Apollo GraphQL Federation**         | A gateway composes N subgraphs into one view                                                                                                    | The hub-federation topology (Option A)                                                                                             |
| **LSP / DAP / CDP / gRPC**            | One connection, many logical channels addressed by a tag; streaming + request/response                                                          | NRP's `open((kind,id))→stream` is this, generalized                                                                                |

### The three cheap invariants to bake in now, and what to defer

The through-line across all of the above:

**Bake in now (near-free with 2 nodes):**

1. **Identity = a keypair.** Give each node (local backend, cloud) a keypair on
   first run; derive its `NodeId` from the public key. Changes nothing
   operationally today; it is the substrate the entire teammate-trust layer
   stands on, and the one thing that is genuinely awkward to add after
   identifiers are already minted. _(Tailscale, Syncthing, AT Proto, libp2p.)_
2. **Every identifier carries its node.** Put `nodeId` on the event envelope and
   in query keys, even when it is always `"local"` or `"cloud"`. This is exactly
   our known sharp edge (the untagged `q:event` bus); populating it with 2 nodes
   is trivial, retrofitting it into a broadcast bus with ~7 consumers later is
   the expensive edge. _(Matrix, email, ActivityPub.)_
3. **Every event carries its source.** A corollary of (2): the fold and the UI
   should always be able to answer "which node emitted this?" _(Matrix `origin`.)_

**Safe to defer (build when the product reaches it — none forces a rewrite if
1–3 are in place):**

- **Discovery registry** (identity → current relay address). Local+cloud are
  known addresses; only teammates need it. _(Tailscale control plane, AT Proto
  DID resolution.)_
- **Capability delegation** (signed scoped grants). Falls out of invariant (1):
  once nodes have keypairs, "read someone's repo" is "sign a scoped grant,
  verify against their published key." _(SSH CA, UCAN, biscuit.)_
- **CRDT / multi-writer merge.** Never needed — single writer per resource.

> **If we do one thing during the local+cloud build: node-tag the event
> envelope.** It is the exact intersection of (a) what every proven system did
> early, (b) our one expensive-to-retrofit edge, and (c) the substrate that makes
> both future topologies (client-direct, cross-org) clean extensions.

---

## The design

### 1. Addressing — `ResourceRef`

```ts
type NodeId = string; // "local" | "cloud" | (later) "peer:<pubkey-hash>"
type ResourceKind = "workspace" | "session" | "fs" | "pty" | "diff" | "repo";
interface ResourceRef {
  node: NodeId;
  kind: ResourceKind;
  id: string;
}
// canonical string form for logs / cache keys: `${node}/${kind}/${id}`
```

Today a remote resource is addressed as `workspace.kind + provider_workspace_id`
— remote, but **centralized through one backend**, the exact assumption a mesh
inverts. The ref carries the node, so the resource is reachable directly.

### 2. NRP — the Node Resource Protocol (the lean sibling wire)

Same transport, same sequenced envelope, same replay as the engine wire — but a
method table about **resources**, not agent turns. Essentially agnt's client
wire, generalized past being scoped to a single `sessionId`.

| method           | dir | purpose                                                                                                                                               |
| ---------------- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize`     | c→n | present auth (token _or signed grant_), negotiate version, receive node id + hosted `kind`s. **+auth** (both existing consumers bolt this on outside) |
| `resources/list` | c→n | enumerate resources of a kind. **+list** (neither existing wire speaks it)                                                                            |
| `resource/open`  | c→n | attach to `(kind,id)` from an optional seq cursor → `{attach, seq}`, then a stream of `event`s                                                        |
| `resource/send`  | c→n | duplex input: a message to a session, keystrokes to a pty, a diff request                                                                             |
| `event`          | n→c | the existing `WireEventEnvelope`, now carrying the `ref`; sequenced, replayable, **sourced by its connection**                                        |
| `events/replay`  | c→n | heal a gap from a seq (`SessionLog`/`SeqCursor`, unchanged)                                                                                           |
| `resource/close` | c→n | detach                                                                                                                                                |

The agent turn collapses into two verbs: **open a session, send a message.**
What was `turn/start` + `RunConfig` + permission RPCs + one-active-turn admission
becomes `resource/send({kind:"session"}, {type:"message.send"})`. The turn is one
registered `kind`, not the protocol.

**YAGNI guard:** we have ~3 node types. Make NRP exactly as thin as those three
need. Do not gold-plate it for nodes that don't exist.

### 3. NodeDriver — owning-node dispatch (replaces the `kind` branches)

```ts
// Shipped (Phase 1) — one method per live-probe op, resolved per owning node:
interface NodeDriver {
  diffStats(): Promise<DiffStats>;
  diffFiles(): Promise<DiffFilesResult>;
  diffFile(file): Promise<DiffFileOutcome>;
  fsTree(): Promise<FsTreeResponse>;
  fsRead(filePath): Promise<FsReadOutcome>;
  fsSearch(query, limit): Promise<FileMatch[]>;
  fsInvalidate(): void;
}
const driver = resolveNode(workspace, workspacePath); // LocalNodeDriver | RemoteNodeDriver
return driver.diffStats(); // one call, one shape, every route
// pty is a STREAM, so it is NOT on NodeDriver — it routes through `ptyRouter`
// (services/node/pty.ts). The ref-shaped `diffSummary(ref)` / `ptyOpen(ref)`
// form is the future NRP direction (§2), not the shipped backend interface.
```

`resolveNode` branches on `workspaceNodeId` — the pure predicate in
`services/node/index.ts` (only `kind === "cloud"` is remote). It **replaced** the
old dead, uncalled `resolveWorkspaceTarget` in `middleware/workspace-loader.ts`,
which was removed in the Phase-1 cleanup (its sibling `computeWorkspacePath`
stays — `withWorkspace` still uses it). `RemoteNodeDriver` wraps the `roundTrip`
primitive that already exists in `services/agent/cloud/driver.ts`. Adding a node
C becomes registering a driver, not editing 10 files.

### 4. The fold — make N transports

`service.ts` today literally binds two transports to one handler
(`localLink.onEnvelope` and `cloudDriver.pushToFold` both call
`handler.handle`). The mesh change is a registry instead of two hardcoded lines.
The envelope contract and the fold are untouched.

### 5. Federation topology — the one real fork

Two fold-hubs already exist (your deus backend; agnt's DO). The only design
decision is _who aggregates the nodes_:

- **Option A — Hub-federated.** One backend holds N `NodeDriver`s, folds all
  state, proxies live-probes; the client stays single-connection. The frontend
  barely changes. The hub is **relocatable** (Mac → cloud worker for Mac-closed;
  agnt's DO already _is_ that hub). Cost: a hub hop in the data path.
- **Option B — Client-federated.** The frontend goes multi-connection
  (`Connection` + `Map<nodeId, Connection>`), node-qualifies query keys, and
  node-tags the event bus. Browser → cloud direct, no hub, lowest latency — the
  north star. Cost: the frontend de-singleton + **the event-bus contract change
  (the crux)**. NRP's per-connection event stream dissolves the untagged-bus
  problem naturally.

A → B is an **upgrade, not a rewrite**: NodeDriver + NRP become B's
direct-connect fast path. The old "frontend → agnt direct for cloud" idea is
just the cloud slice of B.

### 6. Trust across boundaries (the teammate mesh — the only genuinely new build)

Reach is basically solved (the relay already reaches N NAT'd nodes via dial-out).
What's missing is **trust that crosses a boundary**: today every credential is
HS256 shared-secret (only co-located services verify) or an opaque bearer (only
the issuer verifies). The one missing primitive is a **signed, scoped,
offline-verifiable grant backed by an asymmetric issuer identity** (per-node /
per-org keypair, JWKS-style):

```jsonc
{
  "iss": "org:brightco",
  "sub": "user:ada",
  "act": "read",
  "res": { "node": "cloud:brightco", "kind": "repo", "id": "payments-svc" },
  "exp": "<unix-ts, in the future>",
  // issuer signs the canonical claims with ITS private RS256 key; any verifier
  // validates against the issuer's PUBLISHED public key (JWKS) — no shared secret.
  "sig": "<RS256 signature over the canonical claims, by org:brightco's private key>",
}
```

The correct-shaped precedent is already in the repo — but it is **GitHub's**, not
ours: `github_app_installations` = "store the pointer, mint the credential
just-in-time, let GitHub be the authority" (RS256). We build the same for
deus/agnt identities. This layer is orthogonal to A vs B and is built only when
cross-org sharing is a real goal.

---

## Build plan (staged, reuse-first)

Each phase ships something usable, is testable in isolation, and doesn't throw
away the last.

| Phase | What                                                                                                                                                                                                                                                                                           | Kind     | Ships                                                                   | Cost                                  |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------- | ------------------------------------- |
| **0** | Node addressing contract: `NodeId`, `ResourceRef`, `resolveNodeId`; the seam types.                                                                                                                                                                                                            | reuse    | the vocabulary; cloud stops being a special case in principle           | low — **started (see below)**         |
| **1** | `NodeDriver` interface + `resolveNode`; migrate the live-probe `kind==="cloud"` branches behind `LocalNodeDriver`/`RemoteNodeDriver`. **Zero behavior change.** **DONE** for the **diff** + **fs** families (see Progress).                                                                    | refactor | live-probes routed by owning node; adding a node = registering a driver | medium — mechanical, covered by tests |
| **2** | N-transport fold. **Goal already met** for source-agnostic handling — `handler.handle` folds by `sessionId`+`event`, source-blind, two transports already feed one handler. Deliverable: a **tested contract** (node-qualified persistence identity is a separate, deferred step — see State). | reuse    | the source-agnostic-fold property can't silently regress                | low — a test                          |
| **3** | **Option B — client → agnt-direct** (the Phase-3 spike below revised this from the old "Option A"). The real Mac-closed path: de-singleton the WS client, node-tag the event bus, node-qualify keys; agnt's DO is already the cloud hub.                                                       | ship     | Mac-closed cloud, browser → cloud direct                                | high — frontend + event-bus contract  |
| **4** | **Option A** relocatable deus-backend hub — **deprioritized** (would duplicate agnt's store); only if a hosted deus hub is ever needed.                                                                                                                                                        | later    | —                                                                       | large                                 |
| **5** | **Option C** capability layer: per-node keypair, signed grants, JWKS discovery, peer role + registry on the relay.                                                                                                                                                                             | new      | "read someone else's repo" with a scoped grant                          | high — the only new crypto            |

**Near-term scope (what we actually build now):** Phases 0–2 — "clean cloud
integration inside deus," which we need regardless of the mesh, and which shipped
in PR #321. Phase 3 (client → agnt-direct) is the next real chapter but is a
frontend-heavy effort with its own design + e2e. Phases 4–5 are the teammate-mesh
north star — vision, not backlog. Do not build Phase 5 early because it is the
"amazing" part; resist until a real user asks to read someone else's repo.

### Cheap invariants to fold into the near-term phases

- Phase 0/1: `NodeId` is derived so it can later be a **public-key hash** without
  changing call sites (invariant 1).
- Phase 2: when the fold takes N transports, thread a `nodeId` alongside each
  envelope so the source is always known (invariant 3) — even though today it is
  only ever `"local"`/`"cloud"`.
- Phase 4 is where node-tagging the wire envelope lands for real; keeping the
  field present (even unused) from Phase 2 makes Phase 4 additive, not a
  contract break.

---

## Phase 3 — design spike (the honest scope, 2026-08-28)

Reading the actual coupling changed the recommendation. **"Relocate the deus
backend to a cloud worker" is the wrong first move**, because the backend is
deeply Mac-coupled — `better-sqlite3` (native), `node-pty`, fs + file-watching,
Electron IPC, and the runtime cloud-credential push (`cloud/config.ts`:
`runtime.apiKey`, re-pushed by the desktop on auth change). None of that runs in
a Worker; porting it is a rewrite, and it would **duplicate agnt's store**.

The key realization: **agnt's `AgentSession` DO is already a cloud-hosted
fold-hub** — it owns the durable log, replays on attach, and serves browsers over
the client wire. So "Mac-closed cloud" does not need us to relocate _our_ hub; it
needs the client to talk to _agnt's_ hub directly for cloud workspaces.

Two paths, re-evaluated:

- **Path A — relocate the deus backend (old Phase 3).** Host SQLite + query-engine
  - fold + cloud driver somewhere. Large; duplicates agnt; still needs a story for
    the pty/fs/native pieces. **Not recommended as the first move.**
- **Path B — client → agnt-direct for cloud (old Phase 4).** The frontend opens
  the agnt client wire for a cloud workspace's session and folds its events
  client-side (the frontend already runs the same `agentEventFold` reducer). The
  Mac is out of the cloud path entirely. This IS the "relocatable hub" answer —
  the hub is agnt, already in the cloud. **Recommended.**

**So Phases 3 and 4 should swap:** the client-federation work (survey 1 —
de-singleton the WS client, node-tag the event bus) is the real path to
Mac-closed cloud, and Phase 1's `NodeDriver` + the ResourceRef addressing are the
seam it plugs into. It stays a **frontend-heavy effort with its own design +
e2e** (the untagged `q:event` bus is the crux, per Sharp Edges), not an in-session
change — but it's the right target, and it doesn't require porting the backend.

First testable slice of Path B (a future PR): a read-only agnt-direct client for
**one** cloud session — open the client wire, fold its snapshot + events into a
node-qualified cache key, render the conversation — with the Mac backend still
serving everything else. Prove one cloud session renders with the Mac process
killed; expand from there.

## Sharp edges (go in eyes-open)

1. **The untagged `q:event` bus.** Every agent/token/fs/pty event fans out to
   global listeners with **no id and no source**; consumers self-filter by event
   _name_. Federating `q:` forces a wire-contract change (stamp `nodeId`) + a
   rewrite of ~7 consumers, chiefly `useAgentEvents.ts`. Only bites in Option B,
   and NRP's per-connection stream dissolves it. This is the single reason
   invariant (2)/(3) is worth paying for early.
2. **Asymmetric cross-boundary trust.** The only genuinely new crypto. A foreign
   verifier checking a signature it independently trusts requires per-node /
   per-org keypairs + JWKS. Only needed for Option C; GitHub's App model is a
   working blueprint already in the repo.

## Non-goals (now)

- The teammate/cross-org mesh (Phase 5). Designed for, not built.
- Multi-writer / CRDT anything. Out of scope by the single-writer invariant.
- A universal protocol for hypothetical node types. NRP stays as thin as the ~3
  real nodes require.
- Rewriting the frontend to be multi-connection (Phase 4). Deferred until the
  hub hop measurably hurts.

## What is deliberately NOT a `NodeDriver` concern

The `NodeDriver` is for **live-probe request/response reads** — the resources you
fetch per request from the node that owns a _worktree_. Going through every
remaining `kind==="cloud"` site, these are intentionally left out, because
forcing them into a workspace-keyed request/response driver would be the wrong
abstraction:

- **pty** (`commands.ts` `pty:spawn/write/resize/kill`) — a duplex **stream**,
  routed by `ptyId` via `isCloudPty` (a registry lookup), not by workspace, so it
  is **not** part of the request/response `NodeDriver`. It does get its own
  node-router (`services/node/pty.ts`, `ptyRouter`) that centralizes the four
  scattered `isCloudPty` branches — the backend's local-vs-cloud dispatch until
  the NRP wire's `resource/open((kind,id))→stream` takes streams at Phase 4.
  **Live-verified** (2026-08-28): a real terminal driven over the `q:` WS channel
  through `ptyRouter` → node-pty executed a command and streamed its output back.
- **turns** (`commands.ts` `handleSendMessage`) — **not** a clean node-dispatch,
  proven by the code. The cloud lane (`:493–557`) is ~65 lines of sandbox-wake /
  `init_stage` flip / `announceCloudEnv` / github-token refresh / honest-rollback
  **orchestration** with `startCloudTurn` as one call inside it; the local lane
  (`:558–620`) is a different shape entirely (connection + cwd + resume +
  `turnActive` race handling, a richer signature). They are two orchestrations,
  not one operation over two transports — a unified backend "turn transport"
  would fit neither and risk the core path. The turn is a `kind` over the NRP
  wire (`resource/send` on a session), where start + stop live together.
- **stopSession** (`commands.ts:680`) — an id-keyed `isCloudSession` cancel that
  _could_ be extracted cleanly, but turn-start can't; splitting cancel from start
  would be an awkward half-migration. Turns move to NRP **as a whole**, so stop
  stays with start.
- **pr-snapshot** (`pr-snapshot.service.ts` `lookupPrStatus`) — **both lanes run
  `gh` locally**, just with different inputs (worktree remotes vs remote branch
  name). It is not node dispatch (nothing runs on the cloud node); it is a
  local-vs-cloud _input_ difference for a locally-run query. Leave it.
- **archive teardown** (`workspaces.ts:139`) — provisioning **lifecycle** (stop
  the sandbox, delete the wip ref) on archive, not resource access.

## Progress

- **Phase 0 (2026-08-27):** addressing contract in
  `apps/backend/src/services/node/index.ts` — `NodeId` / `ResourceKind` /
  `ResourceRef`, `workspaceNodeId`, `resourceRef`/`workspaceRef`,
  `formatRef`/`parseRef` (prior-art invariant 2), + `test/.../node.test.ts`.
- **Phase 1 · diff slice (2026-08-27):** `services/node/driver.ts` (`NodeDriver`,
  `resolveNode`, Local + Remote). `routes/workspaces.diff.ts` collapsed to
  delegation. Driver unit tests + live e2e (real local diff byte-exact vs git;
  cloud asleep→empty).
- **Phase 1 · fs slice (2026-08-28):** driver grows `fsTree`/`fsRead`/`fsSearch`/
  `fsInvalidate`; the cloud tree cache lifted to `services/node/cloud-fs.ts`
  (single-flight + TTL + identity-gen, unchanged). `routes/files.ts` delegates
  the four branched routes (media routes stay local). Covered by the existing
  `files.test.ts` + `cloud-files.test.ts` (route-level, both lanes) + live e2e
  (real local tree/content/search/traversal-reject). _(Backend suite was 801/801
  at this phase; the shipped PR #321 total, after the fs/pty slices, the fold
  test, and the review fixes, is 816/816 — see the closing note.)_

- **Phase 2 · fold node-agnosticism (2026-08-28):** on reading the actual fold
  wiring, Phase 2's goal is **already met** — `service.ts` feeds one
  `createAgentEventHandler()` from both the local WS link (`onEnvelope`) and the
  cloud driver (`initCloudDriver`), and `handle()` uses only `sessionId`+`event`.
  So no registry refactor (that would be premature abstraction for two
  structurally-different transports). Instead: a **contract test** in
  `agent-event-handler.test.ts` ("node-agnostic fold") proving two sessions fed
  the same envelope shape fold/persist/invalidate/push **identically** — i.e. the
  handler is _source-agnostic_. (It does not verify the two live transports build
  identical envelopes, nor collision-safety for a shared session ID across nodes;
  those are separate — see State.) Regression-proof from here.

Phases 0–2 are complete (live-probe reads migrated; the fold's source-agnosticism
locked in) and shipped in **PR #321** (backend suite **816/816**, typecheck +
lint clean, after the CodeRabbit review fixes: cloud-diff content non-gating, pty
`cwd` forwarding, typed fs returns, and these doc corrections). The next
substantive, user-facing step is **Phase 3 — client → agnt-direct** (the spike's
recommended Mac-closed path; agnt's DO is already the cloud hub), a frontend-heavy
effort. Each remaining phase is its own PR + explicit go.
