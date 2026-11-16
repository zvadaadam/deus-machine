# Deus Machine

IDE for managing multiple parallel AI coding agents. Built for semi-technical people who care about output, not the code underneath. AI chat is the first-class citizen, code is secondary.

Design inspiration: Linear, Vercel, Stripe, Perplexity. Dense, pro-consumer aesthetic.

## Tech Stack

Electron desktop app + React frontend + Node.js backend. Monorepo under `apps/`.

- **Package manager: Bun.** Always `bun add`, `bun install`, `bun run`, `bunx`. Never npm or yarn — CI uses `bun install --frozen-lockfile`.
- **Desktop + Mobile Web:** Primary target is Electron. Web version lives at the root domain (`deusmachine.ai` — the landing worker edge-routes `/` to the landing for new visitors and everything else to the app; `app.deusmachine.ai` stays a working alias (canonical 301 configured at the edge)) and also supports mobile via `MobileLayout`. Don't write `isElectronEnv` conditionals for feature parity.
- **Key libraries:** `ts-pattern` for discriminated unions (prefer `.exhaustive()`), Zustand for UI state, TanStack Query v5 for server state, Framer Motion for presence/layout animations, Tailwind CSS v4.

## Running the App

```bash
bun run dev:web   # Web: backend + frontend (scripts/runtime/dev.ts)
bun run dev       # Desktop: Vite + backend + Electron
```

Never run `bun run dev:frontend` alone — it skips the backend.

New machine or broken toolchain? `bun run doctor` checks Node (22.x, see `.node-version`), Bun, Xcode and the rest; `bun run setup` installs the root, `apps/cloud-relay` and `apps/landing` dependencies.

- Frontend: http://localhost:1420 (Vite auto-increments if taken)
- Backend: dynamic port (check terminal output)

## Cursor Cloud setup

Fresh cloud images should have Bun available. If `command -v bun` fails, install it before any repo commands:

```bash
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
```

For a fresh cloud agent, set up and smoke-test the repo from the workspace root:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run test:backend
bun run test:agent-server
bun run dev:web
```

`bun run dev:web` is the preferred cloud smoke because it rebuilds the Node native module ABI, starts the backend (which runs the agent engine in its process), and then starts Vite with the emitted backend port. Confirm the terminal shows `[AgentService] Engine started, agents: [claude-code, codex-app-server]`, `[BACKEND_PORT]...` and `Server ready!` before opening the frontend URL.

For browser-based UI smoke tests, install the Playwright browser after dependencies are installed:

```bash
bunx playwright install chromium
```

For Linux package/distribution checks:

```bash
bun run package:linux
```

This should produce both `dist-electron/Deus-*.AppImage` and `dist-electron/deus_*_amd64.deb`. On Cursor Cloud, direct AppImage execution may fail without `libfuse.so.2`; use `APPIMAGE_EXTRACT_AND_RUN=1` for smoke tests in that environment.

## Architecture (2 Processes)

```text
Frontend (React)
  ├── WebSocket → Backend (apps/backend/) — every read, write and stream
  ├── Electron IPC → Desktop Main (apps/desktop/) — native ops only
  └── HTTP → Backend — only what a socket cannot serve (pairing, OAuth, file streaming)

Backend ⊃ Agent engine (apps/agent-server/) — in process, the standard wire on an in-process channel
```

**Electron Main** — Thin shell. Window lifecycle, native dialogs, process spawning. No business logic. It starts the backend and restarts one that exits, five times at most unless one stays up a minute (`backend-process.ts`). The backend stops when the desktop does, however that ends: its stdin is a pipe the desktop holds (`apps/backend/src/lib/parent-stdin.ts`). The preload offers the window only what the web app calls, and never the backend's spawn token; `test/unit/desktop/ipc-surface.test.ts` holds the preload, the main handlers and the web app's calls equal, so an unused channel is deleted, not kept.

**Backend (Hono)** — All business logic. DB reads/writes, config, agent event persistence, tool relay, PTY, file watching. Operations in `src/api/`, answered over the socket; the few HTTP routes under `/api`. Runs the agent engine in its own process.

**Agent engine** (`apps/agent-server/`) — Stateless. `@zvada/agent-server` with deus's seams: the in-process deus MCP tools, the tool policy, checkpoint hooks and titles. No DB access, no direct frontend communication; the tools reach the backend through `host-link.ts`, which the backend registers (`startEngine`). Keep blocking work off it: it shares the backend's event loop. A turn does not survive the process (the engine keeps turns in memory), so at engine start every local chat the database still shows working or waiting is settled as an error saying Deus quit mid-turn (`settleInterruptedSessions` in `services/agent/persistence.ts`; cloud chats are the platform's to settle).

**Rule of thumb:** Needs native Electron API? → Main process. Everything else → Backend (or the engine's seams, for what a turn runs).

### The @zvada/agent-server package (upstream engine + wire)

The agent-server runs on the upstream **[`@zvada/agent-server`](https://github.com/zvadaadam/agent-server)** package (same author as this repo): `/core` is the engine (AgentRuntime + Claude/Codex/ACP harness adapters), `/protocol` the zod wire contract, `/server` the JSON-RPC 2.0 wire (per-session `seq`, bounded replay, quick-ack turns), `/client` the typed consumer the backend uses. The backend serves the engine on an in-process channel (`apps/agent-server/index.ts`: `startEngine`, `beginTurnStart`, `beforeCancel`) and talks to it through `AgentLink` (`apps/backend/src/services/agent/client.ts`); the deus tools' requests and titles are direct calls into the backend (`host-link.ts`).

When debugging agent-server behavior (event shapes, turn admission, cancel semantics, resume, provisioning), **read the package source — you have full access**:

- `node_modules/@zvada/agent-server/src/` — the package ships readable TypeScript source, not compiled JS. This is the fastest reference and always matches the installed version.
- Local clone at `~/Developer/agent-server` (Conductor-managed; work lives on branches/origin, the main checkout is a stale empty worktree) and https://github.com/zvadaadam/agent-server for history, DESIGN.md, and plans/.
- Engine bugs belong upstream (branch + PR there, then bump the pin here); deus consumes the engine protocol natively (no translate layer) — consumer-side behavior lives in the backend's `services/agent/` fold-and-persist path and the frontend's `agentEventFold` projection.
- Deus keeps no list of models. A local chat's pickers read what this computer's CLIs list for its login (the engine's `models/list`, as `q:request agentModels`); a cloud chat's read the platform's (`cloudModels`, the same engine's catalog); before an answer, the catalog the embedded engine was built with. `shared/models.ts` holds only Deus's own choices: the harness names and the model and thinking level a new chat starts on. A model missing from a picker is an engine pin to bump, not a row to add.

### WebSocket Query Protocol

Single WS connection (`/ws`) using `q:` prefixed JSON frames:

| Frame                                    | Purpose                                                                                                    |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `q:request` / `q:response`               | A read, answered once (`diffStats`, `settings`)                                                            |
| `q:subscribe` / `q:snapshot` / `q:delta` | A live read: its value, sent again whenever it changes (workspaces, stats, sessions)                       |
| `q:subscribe` / `q:event` / `q:reset`    | A stream of events, sent only to the connections following it (a chat's agent events, a terminal's output) |
| `q:mutate` / `q:mutate_result`           | A write, never sent twice (archiveWorkspace, sendMessage, stopSession)                                     |
| `q:tool_response`                        | The answer to something an agent asked this client                                                         |

**One contract.** Every operation and stream a host offers is declared once in
`shared/api/<domain>.ts` (`read`, `live`, `write`, `stream`, `resumableStream`:
its name, zod input and output type) and exported together as `api` from
`shared/api`. The backend answers each operation with one handler in
`apps/backend/src/api/<domain>.ts` (`handle(api.x, fn)`); a test holds the two
lists equal. Clients use the declaration itself: `call(api.x, input)`,
`useQuerySubscription(api.x, …)`, `useStream(api.x, filter, onEvent, onReset)` or
`follow(…)`. There is no second list of names and no HTTP route per operation.
The HTTP routes left are the ones a socket cannot serve: pairing, OAuth
callbacks, the MCP gateway, file streaming, and what the CLI and the desktop
shell ask before a socket exists.

**Streams** (`apps/backend/src/services/streams.ts`). Nothing is broadcast. A
service publishes an event under a stream and a scope
(`publish(sessionEvents, { sessionId }, event)`); a connection receives it only
if it subscribed to that stream with a filter the scope matches. A resumable
stream numbers its kept events per scope and remembers the recent ones. A
subscription is acknowledged (`q:subscribed`) with where its scope stands; a
client that reconnects names the last number it has and is sent what it
missed, or a `q:reset` when the host no longer holds that far back (a restart
included: a number never means two events, even across processes). A chat's
stream then opens with any part still being typed, as it stands
(`services/agent/open-parts.ts`), so a client that returns mid-reply shows the
whole reply so far. A transcript is read once (`messages`) and then changes on
a client in one way only: its chat's stream, folded into the page. The
client package does this bookkeeping; a consumer supplies only `onReset`
("something may have been missed: read the state again"). So a reconnect does
not reload the chats a window holds, and a phone following one chat is not
sent every other chat's tokens.

The private workspace package `@deus/runtime-client` (`packages/runtime-client/`)
owns transport, pending operations and subscriptions. Its root entry has no React,
TanStack or app dependencies; `/query` adds a dedicated TanStack Query cache.
`apps/web/src/platform/ws/runtime-client.ts` binds the package to the Deus
contract (`call`, `follow`), cache defaults and the cache-to-runtime lookup. Keep host selection,
credentials, routing, React hooks and domain projections in the app. The package
uses the existing `q:` wire; `@zvada/agent-server/client` serves the separate agent
execution protocol. See `packages/runtime-client/README.md` for the boundary.

The shell selects a host, account and authorization grant; changing any of them
disposes the old runtime and remounts the cache provider. Async flows must retain
their originating client across awaits. Equal resource/parameter subscriptions
share one wire subscription, and equal resource/parameter/query-key bindings
share one cache projection. Agent folds and cloud-direct channels belong to that
same cache and survive reconnects (only disposal drops them). Reconnect restores
reads and streams; it never resends writes. A lost acknowledgment is an
`unknown-outcome`, not permission to retry a write. Correlated ping/pong probes detect silent
connections (30s interval, 10s timeout). When a relay host is replaced,
already-authorized viewers reconnect and authorize again before their
subscriptions resume; a connected tunnel alone is not readiness.

### Starting a workspace (`services/workspace-init.service.ts`)

A workspace is created in one place: Home, whose composer sends the first
message with it. Everything that wants one goes there through
`openNewWorkspace({ repoId?, draft? })` (`features/workspace/lib/newWorkspace.ts`):
the sidebar's "New workspace" row, a project's "+", the command palette, a
starter prompt, and every way of adding a project (open, clone, new), which
ends on Home with that project chosen. There is no creation dialog. The one
exception has its subject already: a workspace on a pull request or branch
(`GitHubPickerModal`).

Creating a local workspace writes its row and returns. The rest runs in the
background, in four stages: `fetch` (origin's latest for the branch it starts
from), `worktree` (`git worktree add` on a new branch), `setup` (the project's
setup script), `session` (the first chat, and `state = 'ready'`). Each stage
writes `init_stage` and pushes the `workspaces` resource, which is the only
progress channel: the desktop, the web app and a phone all follow it.

- Only `worktree` and `session` are fatal. A fetch that fails still starts the
  workspace, from what is on this computer, and records why
  (`init_fetch_issue`: `offline`, `auth` or `failed`); a setup script that fails
  is `setup_status = 'failed'`, with its own retry.
- A fatal failure removes what the attempt made and leaves `state = 'error'`
  with a plain reason (`error_message`) and the tool's own words
  (`error_detail`). `retryWorkspaceInit` starts the same row again, so whatever
  is keyed by its id survives (the web app keeps the first message waiting for
  it, `workspaceStartStore`). `deleteFailedWorkspace` removes a workspace
  that never started and refuses any other: a used one is archived.
- A backend that stops mid-start leaves `initializing` rows nothing is working
  on. `failInterruptedWorkspaces` fails them at startup.
- Git commands that can run long go through `lib/git-process.ts` (`runGit`):
  no prompts, their own process group, and a timeout that stops the whole
  group. An `execFile` timeout stops only git itself, and `git worktree add`'s
  checkout child keeps writing; a worktree cut short stays locked, which only
  `git worktree remove --force --force` clears (`removeWorktree`).
- A name is free only if the database, the `.deus` folder and the repository's
  branches all lack it; a name found taken is never reused or removed.
- Cloud workspaces provision through `cloud-workspace-init.service.ts`. They
  share the `error` state, and the same retry and delete while no cloud
  computer exists for them; once one does, waking it is the way back.

In the app a start is told in the transcript, by the line cloud provisioning
uses (`session/ui/EnvGroup`): `workspaceStart(workspace)`
(`features/workspace/lib/startState.ts`) reads the row into steps, warnings
(started without the remote's latest, setup script failed) and a failure, and
`WorkspaceStartGroup` renders it, with Retry and Delete on a failure. The
message always comes first and the line under it: before the workspace has a
chat, the waiting message and then the line are the page
(`WorkspaceStartState`); once it is ready, the chat it started with shows the
line under its first message, as a cloud chat shows its computer's
provisioning. In a ready chat the line is per client and in memory
(`workspaceStartStore`), as a cloud chat's provisioning story is.

Home keeps the typed message in its composer until the workspace exists, so
one that could not be created is still there to send again. From then on the
message waits in `workspaceStartStore`, keyed by workspace,
and `useFirstMessageDelivery` (mounted once, in `MainLayout`) sends it to the
workspace's first chat when that workspace is ready, whichever one is on
screen; `session/lib/firstMessage.ts` holds the rules. It is kept in
sessionStorage, so reloading the window does not lose it, and it is sent once:
a chat that already has a message, or is answering one, is never sent it
again, and a send the backend refuses goes into that chat's composer with a
toast rather than being retried. Send it from anywhere else and two workspaces
started in a row lose one.

`hasCheckout(workspace)` (it has a chat) says whether there is somewhere to
work. Without one there is no branch to open a pull request from and nothing
for the tools to show, so a workspace that failed to start (`failedToStart`)
is the chat column alone. A workspace that is still starting can be opened
from the sidebar; its row, the header chip and the chat word the step the
same way (`workspaceStart(workspace).brief`, `SETUP_RUNNING`, `SETUP_FAILED`).

The start page has the chat's composer (`WorkspaceStartComposer`), where the
chat will have it, keyed by the workspace since there is no chat yet. One
message waits per workspace: sending there when nothing waits makes it the
waiting message, and a second is refused in words and stays in the box. What
was typed there moves to the chat's composer when the chat opens
(`sessionComposerActions.move`, from `useFirstMessageDelivery`), before the
waiting message is sent. The waiting message is per client, so another device
or window can speak to the chat first; this client's message is then never
sent, and goes into that chat's composer instead (`missedFirstMessages`). A
failure that cannot be retried has no composer: nothing typed there could be
sent.

`bun run test:e2e:workspace-start` runs these against the real backend, git and
web app (see `test/e2e/README.md`).

### Remote access (relay)

Remote access is bound to the Deus account, like Conductor's and ChatGPT's:

- **Deus Cloud** (AGNT `apps/deus-cloud`, `/me/machines`) lists the account's
  computers and signs one-use, 60-second relay tickets (ES256). The desktop
  backend registers its computer per signed-in account
  (`services/remote-machine.service.ts`, records in the private `relay_machines`
  setting) and needs that computer's own secret to host it.
- **The relay** (`apps/cloud-relay`) admits a socket only with a ticket for that
  machine and role (`deus.relay.v2` subprotocol + ticket), verifies it with
  public keys (`RELAY_TICKET_JWKS`), consumes it once, pins the machine to its
  first host's account, and names the verified account on `client_connected` and
  `pair_request`. It has no public status route and holds no minting key.
- **The Mac** approves each device once (pairing code, or the QR link
  `/s/<machine>#pair=CODE`, whose fragment never reaches a server) and binds the
  grant to the relay-verified account and this machine id
  (`paired_devices.account_id`, `machine_id`). Relay grants work only through the
  relay; local-network (direct) grants only directly. The tunnel follows the
  desktop's account: sign-out closes it, switching accounts replaces it. A
  computer removed from the account stays off (and its relay grants are retired)
  until remote access is turned on again. Only the desktop process that spawned
  the backend (its `AUTH_TOKEN`) may hand it account credentials.
- **The browser** signs in with its own `deus-web` session, lists computers at
  `/connect`, and stores grants per account and computer, so signing out keeps
  them and signing back in reconnects without a code. Every dial fetches a fresh
  ticket; an expired session (401), a refusal (400/403) or a computer the account
  lacks (404) stops redialing. A relay refusal looks like a network failure to a
  browser, so it redials with backoff. Pairing pages and the Mac's dialog show the
  computer's name and id fingerprint, so a code is typed into the right computer.
- **Assistants** (ChatGPT, Claude, a CLI agent) reach the Mac with one URL,
  `<Deus Cloud>/mcp/<machine id>` (remote MCP, OAuth). Deus Cloud only carries
  the request: it dials the relay as a client, hands over the assistant's own
  access token, sends the MCP body as one `agentMcp` write and returns the
  answer (null is a `202`). Of MCP it reads only three method names:
  `tools/call`, to refuse one in a form a model reads, and `initialize` and
  `tools/list`, to answer them from what it remembers while the computer is
  away. The Mac verifies the token itself (`services/assistants/token.ts`, the
  same check as Deus Cloud's: the pinned issuer's keys, RS256 or ES256 only,
  exactly one `aud` and that URL, `sub` the account the tunnel hosts, no
  `sub_profile: ai_agent`, `client_id` the assistant); keys it cannot fetch
  (no answer, not a 200, not JSON) are "could not check the sign-in right
  now", never a refusal of the sign-in. A first contact is
  stored `pending` (`assistants` table); the person allows `read` or
  `operate`, or denies it, in Settings, Remote access, Assistants. Denied is a
  state: the row stays and its next contact is refused ("This assistant was
  denied on this computer."); Remove forgets it, so it comes back as a first
  contact. One not seen for 30 days is forgotten the same way, unless it was
  denied (`store.forgetUnused`, run at admission and at startup, never on a
  timer; the list, a pure read, leaves such rows out until then), so a client
  that registers itself anew at each sign-in (Codex) leaves no allowed entries
  behind. A change or removal closes its connections. Its `name` and `host`
  (where its sign-in returns to, shown because a name can be faked) come from
  Deus Cloud (`GET /me/assistants/<clientId>`, never blocking admission; a
  failed lookup is tried again on a later contact, at most every five
  minutes); a URL-shaped client id's host stands on its own. The `assistants`
  live read is pushed only when something a person sees changes (a first
  contact, access, a name or host learned); `last_seen_at` is written at most
  once a minute. A connection ends at its token's `exp` (plus the 30s clock
  tolerance) and lives at most 200s whatever its traffic (Deus Cloud opens one
  per request); pings extend neither. That end is the caller's `endsAt`
  (`Caller` in `api/registry.ts`, from the connection): the operator's
  `maxWaitSeconds` is a function of the caller (`maxWaitFor` in `host.ts`),
  90s or the time left less a 5s margin, whichever is less, so a held call
  answers "still working" with the wait hint before its connection is cut. The
  window and paired devices have no `endsAt` and keep the 90s cap. Managing them (`assistants`,
  `setAssistantAccess`, `removeAssistant` in `shared/api/assistants.ts`) is
  full access only. The address a person pastes into one is the tunnel's, on
  `relayStatus` (`assistantUrl`).
- **What an assistant reaches**: one operation, `agentMcp` (one MCP JSON-RPC
  message or a batch in, the response, an array or null out). This computer
  answers MCP itself: the handler is `createMcpHandler` from
  `@zvada/agent-server/operator`, built once in `services/assistants/operator.ts`
  (server `deus`, titled "Deus on <computer name>", `services/server-name.ts`).
  `tools/list` is the same for every caller, since assistants keep it from when
  they connect. The registry refuses an assistant everything else
  (`ASSISTANT_OPERATIONS`) and the query engine its `q:subscribe` and
  `q:tool_response`; this computer's window and paired devices may call
  `agentMcp` too. A first contact is recorded at admission, so one that has
  only sent `initialize` is already listed. `pending` and `denied` run no tool,
  `read` only the tools that read; this computer's window and paired devices
  run every tool. A refusal reaches the model as an `isError` tool result.
  Access is read again from the table just before every write a call makes
  (`services/assistants/access.ts`), since a held call or message (a first
  message waiting for setup, an interrupt waiting for a stop) can outlive the
  person's change of mind: run every operation a tool makes through the host's
  `act`, and call `assertMayWrite` just before each of the host's own writes
  that is not an operation (holding or dropping a first message, answering a
  request). A refusal (an `OperatorError` or `AppError`) is a sentence
  that says what to do; any other failure inside a tool is reported and reaches
  an assistant as one generic sentence (`ASSISTANT_FAILURE`, applied in the
  tool source's `call` in `operator.ts`, and by the query engine for an
  operation that fails), never its internal text.
- **The tools.** The session tools (`list_sessions`, `read_session`,
  `start_session`, `send_message`, `wait_for_session`, `watch_sessions`,
  `answer_request`, `stop_session`) and their words come from
  `@zvada/agent-server/operator`; Deus is their host
  (`services/assistants/host.ts`) and adds `read_changes`,
  `archive_workspace` and `send_feedback` (a report about Deus itself to the
  Deus team's Hivenet board, `services/assistants/feedback.ts`: the report
  alone, `consent.telemetry: false`; read access is enough). A session is a workspace's current chat (its slug, under
  its project). Assistants see this computer's own workspaces only for now: the
  host leaves cloud workspaces out of the list and every lookup, and
  `start_session` always makes a local workspace. An archived workspace is not
  listed; one named (by name or id) is refused as archived, not as unknown
  (the host's `entry`). Every read, send, stop and
  answer goes through the app's own operations as this computer
  (`runAsThisComputer`). A message continues the chat as its composer would
  (`turn-settings.ts`). The tools take no request ids. An identical request from the same
  caller (an assistant's client id, a device, or this computer's window)
  while the first is in flight runs nothing new (`duplicate: true`): for
  `send_message`, the same chat and trimmed message while its turn is being
  sent or runs, whatever `interrupt` says; for `start_session`, the same
  project and message while its workspace is set up or its first
  turn runs. None of it is stored. A session's id is its workspace's, always.
  `start_session` returns once the workspace row exists; the host keeps the
  first message and sends it through `act` when setup ends (30
  minutes at most). A workspace being set up reads `working`; a send to it is
  refused unless it is an `interrupt` replacing the first message the host
  holds, which its reply says (`SendResult.note`); a stop drops that message and says so. Why a first message was not
  sent (a failed start, a refused send, the 30 minutes) is the error while the
  chat has no messages, then is said once in the outcome note. `archive_workspace` names the branch it keeps, refuses a workspace being set up and removes
  one whose start failed. The host's `groups` lists
  every project, so `list_sessions` names projects with no session. `read_changes(file)` shows only a file in the
  workspace's changed-files list (normalised paths): git prints a whole file
  as the diff of an unchanged one, and that may be an ignored secret. What a
  repository wrote (file names, diffs) and names follow the module's
  untrusted-text rule: a name is one JSON-quoted line (`quoted()`), a diff a
  block of quoted lines (`quote()`), so no line of it reads as one of the
  tool's own.
  An answer takes the one path a card's does (`tool-relay.ts`
  `answer`): whoever answers first, the others' question or plan card is
  withdrawn, and a client that starts following one chat's or every chat's
  `toolRequests` is first sent what still waits.

Admission is checked when a socket opens (no leases), and the relay can still read
`q:` frames: end-to-end encryption is separate work. `DEUS_RELAY_URL` points the
backend at a local Worker; `bun run test:e2e:remote-access` runs the whole stack.
The production ticket key pair is backed up in the gitignored `.env.relay-tickets`
at the repository root (copied into new worktrees); its private key is Deus Cloud's
secret and must never be printed or committed. `apps/cloud-relay/.dev.vars` holds the
local relay's development JWKS.

### Customize: Apps, Plugins and Skills (`services/integrations/`)

The Customize page (`features/customize`) has three views over one install system:
**Apps** are MCP servers (Connect → OAuth or a pasted key), **Recommended
Plugins** bundle apps and skills for a job (Install), **Skills** are Agent Skills
folders (Add); opening one replaces the catalog with its page, never a dialog.
The curated catalog is data in `shared/integrations/catalog/` (each app's
endpoint verified, each skill pinned to a commit; brand marks via
`bun scripts/generate-integration-icons.ts`). Deus implements no app: an entry
points at a vendor's remote server, a package to run locally, or a broker's
toolkit. `shared/integrations` imports nothing but zod (a test holds it), so
the catalog can move to a package the day Deus Cloud reads it too.

- **Install once, every project inherits.** `extension_installations` rows are
  account-wide on this computer — no per-workspace bindings. Installing and
  authorizing are separate states ("Installed · needs sign-in" is valid). A
  plugin's parts are `explicit = 0` and go when no installed plugin lists them
  (membership is read from the catalog, never stored); anything the user added
  or connected themselves stays.
- **Two reads, not one.** The catalog is static for a build: clients read it
  once (`integrationsCatalog`). The `integrations` resource pushes state only
  (a few kilobytes) and `shared/integrations/compose.ts` joins them. Lists one
  page needs (`appTools`, `skillContent`, `localSkills`) are requests. Nothing
  a client reads ever carries a credential.
- **Credentials.** An account's row says how it is held
  (`integration_connections.kind`): `oauth` and `secret` (a pasted key, a
  local server's variables) keep a credential sealed by `vault.ts` (key in the
  macOS Keychain, else a 0600 file; found once at startup, and until the
  Keychain answers nothing is sealed or opened, never a second key made); `cli` stores
  nothing (the signed-in CLI supplies the token at each use); `managed` is
  held by Deus Cloud. A credential sealed under a lost key opens as null and
  its app asks to connect again.
- **The gateway is the only door.** A turn's config names an app with an account
  as `http://127.0.0.1:<port>/api/integrations/mcp/<app>` plus this process's
  key (`gateway.ts`). Each request gets the account's current credential
  (`credentials.ts`) and is streamed to the real server; a 401 is retried once
  with a fresh one. So a turn start does no network work for apps, a token
  that expires mid-turn is refreshed on the call that needs it, and no agent
  process or config file (Codex writes its MCP servers to disk) holds a
  provider's token. Never put an account's token in a turn's `mcpServers`.
  Local (stdio) servers and servers with no account are named directly.
- **OAuth** (`auth/mcp-oauth.ts`): signing in runs the MCP SDK's `auth()`
  (discovery, dynamic client registration, PKCE; the callback at
  `/api/integrations/oauth/callback`; one in-memory attempt per connection,
  newest wins). Refreshing calls `refreshAuthorization` directly, single-flight
  per connection, and tells "sign in again" (grant refused) from "try later".
  Tokens are bound to the server URL they were issued for. Servers that accept
  only vendor-approved clients are `registration: "preregistered"` and use a
  client from `auth/clients.ts`.
- **Apps that connect through the Deus account** (`sign-in-route.ts`,
  `cloud-apps.ts`, `auth/cloud-accounts.ts`). A catalog app may name a broker that can hold
  its account and serve its tools: `broker.provider` (`composio`) and
  `broker.toolkit`. `signInRoute(app)` picks: a vendor-gated app signs in
  directly once Deus has its own client, and goes through its broker until
  then; an app with no server of its own always does (its transport is
  `broker`, its auth `managed`). Only Deus Cloud talks to a broker (AGNT `apps/deus-cloud`,
  `/me/connections`, LLP 0004 "App connections"): the Composio key can act on
  every connected account, so this app has no code path that holds one (a
  test scans for it). The route therefore needs the person signed in to Deus
  (`unavailable: "account"`, and the blocked state is the sign-in button);
  an app Deus Cloud does not serve yet is `"soon"`. This computer keeps one
  row per app and Deus account (`auth_kind = managed`, `deus_account_id`, no
  credential), as Deus Cloud keeps one connection per account and app. Its
  requests go through the gateway to the connection's MCP endpoint in Deus
  Cloud with the Deus session, read per request. A sign-in returns to
  `/api/integrations/oauth/callback/<attempt>`; whether it worked is asked
  of Deus Cloud, never read from the page. `reconcileCloudAccounts()` follows
  the account (startup, sign-in, renewal, switch, sign-out): signed out, the
  apps pause and their rows wait; another account's rows are dropped here
  only; an installed app the account connected elsewhere is ready with no
  sign-in. Disconnecting or removing the app disconnects the account in Deus
  Cloud, for every computer: the row leaves its app and stays as `removing`
  until Deus Cloud confirms, so a request that fails is made again at the
  next pass and the account is not adopted back meanwhile.
- **Cloud turns** (`cloud-turns.ts`, behind `DEUS_CLOUD_EXTENSIONS=1` until
  the platform this build talks to accepts the options). A cloud turn's
  options carry two complete sets: the skills to place in the sandbox, and
  the MCP servers of the installed apps that reach the cloud
  (`appReachesCloud`, one rule for the backend and the page): an app Deus
  Cloud holds an account for, or a public remote server that needs none. The
  sandbox's agent gets a capability for the first kind (`cloudTurnServers`):
  it can call those apps' tools for eight hours and nothing else, and one is
  reused across turns until the apps change or it nears its end. Neither the
  Deus session nor an account held on this computer ever goes to a sandbox.
- **Where accounts are headed.** Accounts that sign in directly (the MCP
  OAuth flow, a pasted key) are this computer's, so cloud agents do not get
  them. The plan is for Deus Cloud's `Connections` to hold those too, and
  for the platform to resolve an account's connections at dispatch, the way
  it resolves provider accounts, so a turn started without this computer
  gets them as well. Do not ship account tokens to a sandbox through turn
  options.
- **Codex** takes per-turn servers only in a session-owned `CODEX_HOME`
  (`codex-homes.ts`: the user's login, instructions and skills linked in, not
  their history; pruned when its session is deleted). `codexTurnHome` says
  which chats get one: a chat that begins once an app is installed, ready or
  not, and keeps it; with no app installed a chat stays in the user's own
  home and gets no apps later. Codex itself accepts
  them in a thread's `config` with no home; when the engine delivers them that
  way, the session homes go.
- **Skills on disk** (`skill-files.ts`) use the Skills CLI layout: files in
  `~/.agents/skills/<name>` (Codex), a symlink in `~/.claude/skills/<name>`
  (Claude), a `.deus-skill.json` marker. Nothing without the marker is replaced
  or removed; a folder is swapped in by two renames, never half written.
  `DEUS_SKILLS_HOME` points it elsewhere (tests, dev).

### Adding an operation or a stream

1. Declare it in `shared/api/<domain>.ts`: `read` (asked once), `live` (a read
   clients subscribe to), `write`, or `stream` / `resumableStream` (events). Its
   `name` on the wire is the name it is exported under (a test holds that).
2. Answer it in `apps/backend/src/api/<domain>.ts` with `handle(api.<name>, fn)`.
   A live read's handler is synchronous. A stream has no handler: the service
   that produces the events calls `publish(api.<name>, scope, event)`.
3. For a live read, call `invalidate(["<name>"])` wherever its value changes.
4. In the frontend: `call(api.<name>, input)`;
   `useQuerySubscription(api.<name>, { queryKey, params })` with
   `staleTime: Infinity`, `refetchOnWindowFocus: false` (the socket keeps it
   fresh); `useStream(api.<name>, filter, onEvent, onReset)`.

## Database

Own SQLite at `~/Library/Application Support/com.deus.app/deus.db`. Schema in `shared/schema.ts` — 13 tables: `repositories`, `workspaces`, `sessions`, `messages`, `turns`, `parts`, `compactions`, `paired_devices`, `assistants`, `automations`, `automation_runs`, `extension_installations`, `integration_connections`.

- Turn accounting, execution, provider account snapshots and outcomes belong to `turns`, keyed by `(session_id, turn_id)`. Messages contain transcript content only. `db/migrate-turns.ts` moves existing message accounting once at startup without deleting history.
- Only the backend writes to DB
- All indexes/triggers defined in `shared/schema.ts`
- Use `sessions.last_user_message_at` instead of correlated subqueries
- No N+1 queries — batch or denormalize
- Column changes, pre-launch (now): destructive resets are sanctioned. There are no users to migrate, and `shared/schema.ts` is the fresh schema rather than a migration replay — a stale local DB is detected via the `PRELAUNCH_REQUIRED_COLUMNS` / `PRELAUNCH_RETIRED_COLUMNS` markers and reset with the `PRELAUNCH_SCHEMA_RESET_HINT`. Drop the column and add it to the markers.
- Column changes, post-launch: the above stops applying. Deprecate by renaming with a `DEPRECATED_` prefix, never drop.

## Testing

```bash
bun run test:backend          # apps/backend/test/unit/
bun run test:agent-server     # apps/agent-server/test/
bun run test:app              # test/unit/ (web app, desktop main, runtime scripts)
bun run test:runtime-client   # packages/runtime-client/test/ (no app aliases or React)
```

Vitest with `vi.mock()` and `vi.hoisted()`. Tests live outside `src/` — never colocate.

`bun run typecheck` covers the web app and `shared/` only. A backend change is
checked by `bun run typecheck:backend` (its tests included), and
`bun run typecheck:all` runs every program.

`bun run knip` is the dead-code check, and CI fails on it: a file nothing
imports, a dependency nothing uses, or one used but not declared. Unused
exports are warnings. It covers the root package and `packages/*`;
`apps/cloud-relay` and `apps/landing` install on their own and are outside
it. Delete what it finds rather than adding to its ignore lists (`knip.json`),
which hold only what it cannot trace: the shadcn component library, the
`native` bridge object, and a few packages no import names (Tailwind, loaded
from CSS; the native modules and tools the build and packaging scripts call).

## Design ↔ code sync (design/deus.pen)

The app UI is designed in `design/deus.pen` (Pencil). The file is encrypted — read and
edit it only through the Pencil MCP tools (`get_app_state`, `execute`), never with `Read`
or `Grep`. Pencil is an external design tool; it is not bundled into Deus. The
`design/` folder and its documents are independent of product integrations.
The retained Design-tab and Pencil mockups are historical after the embedded
integration's removal; preserve those documents rather than restoring the feature.

`deus.pen` is a reconstruction of `apps/web` as it exists today, not a moodboard:

- **Variables are the CSS.** Every colour, radius and type step is a Pencil variable named
  after its custom property in `apps/web/src/global.css` (`bg-elevated`, `text-tertiary`,
  `border-subtle`, `radius-lg`, `text-base`, …). The `mode` theme axis carries `:root`
  (light) and `.dark` — the same two palettes.
- **Components are the components.** `DS/*` frames map one-to-one onto React components;
  the frame name points at the file that renders it (`DS/SidebarRow-Workspace` →
  `features/sidebar/ui/WorkspaceItem.tsx`). Instance overrides stand in for props.
- **Screens are real states**, at the sizes the app ships: 1440×900 desktop, 390×844
  mobile. Every content tab, all nine settings sections, every dialog and the mobile
  layouts are drawn — not just the happy path.

Top-level frames are numbered by band: `00` overview, `01–05` foundations (colour/type/
radius, motion, elevation, iconography, interaction states), `10–26` the component library,
`30` states, `40–49` screens, `47a–e` the onboarding flow, `48a–f` Customize, `50–58`
settings, `60–66` overlays, `70–73` mobile, `80` the `/connect` route, `90` the landing
site. Keep the numbering when you add to it.

The landing site (`apps/landing`) does not share these tokens — it has its own shadcn/Geist
palette, namespaced `lp-*` in the design file, and ships dark-only. Never bind an app
screen to an `lp-*` token or the reverse.

`design/README.md` holds the full component → file and variable → token mapping.

**The rule:** whoever changes one side changes the other in the same piece of work. Ship a
UI change in code, update the matching `DS/*` component or screen; change the design,
follow it with the code change. Divergence between `deus.pen` and `apps/web` is a bug. If
another session owns the file right now, note the divergence instead of editing in
parallel.

Two things the file cannot render exactly, both documented on canvas: corners ship as
`corner-shape: superellipse(1.5)` with every radius token scaled ×1.25 (`md` = 10px, not
8px) and Pencil can only draw circular arcs; and the system font stack (SF Pro Text / SF
Mono) is substituted with Inter / Roboto Mono because Pencil carries only Google fonts.
Use the scaled radius values — they are what ships in supporting browsers.
Buttons reuse `radius-lg` (10px circular fallback, 12.5px continuous corners);
circular controls retain `radius-full`. See `design/controls.md`.

Working notes for the Pencil editor: set variables before nodes; the canvas has no
autosave, so save with `osascript -e 'tell application "Pen" to activate' -e 'tell
application "System Events" to keystroke "s" using command down'`; layout/render goes
stale after long editing sessions — save and relaunch Pen to get accurate screenshots. A
component instance resolves its theme once per document, so light-mode sheets are built
from primitives rather than instances.

## Hard Rules

- Never edit outside your worktree directory
- Never start the app outside your worktree directory
- Never use npm or yarn
- WebSocket push over polling — only poll for git diffs on working sessions
- All colors via CSS variables/tokens, never hardcoded

## Feedback to Deus

When a Deus tool, command, doc, or API is broken, confusing, or notably good,
report it (category: tool | skill | prompt | docs | mcp | cli | api | model | ux | other):

```sh
npx --yes hivenet@latest --to deus --category <category> --subject "<exact item>" "<specific, actionable feedback>"
```

Failed a Deus task after real effort? Report it structured — these become
Deus's eval suite, so word the task so a stranger could re-run it:

```sh
npx --yes hivenet@latest --to deus --category <surface it failed on> --task "<the goal>" --expected "<correct outcome>" --actual "<what happened>" --attempts <n> "<one-line summary>"
```

The response may include an `ask`: a question from the Deus team with a
ready-to-run answer command. Answer only from what you did this session; skipping is fine.
Continue a thread with `--resume <threadId>` (printed after each submission).
Set `DO_NOT_TRACK=1` to strip auto-detected context. Only specific, actionable reports.
