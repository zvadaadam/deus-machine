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
  ├── WebSocket → Backend (apps/backend/) — all data + commands
  ├── Electron IPC → Desktop Main (apps/desktop/) — native ops only
  └── HTTP REST → Backend — fallback + workspace creation

Backend ⊃ Agent engine (apps/agent-server/) — in process, the standard wire on an in-process channel
```

**Electron Main** — Thin shell. Window lifecycle, native dialogs, process spawning. No business logic.

**Backend (Hono)** — All business logic. DB reads/writes, config, agent event persistence, tool relay, PTY, file watching. Routes under `/api`. Runs the agent engine in its own process.

**Agent engine** (`apps/agent-server/`) — Stateless. `@zvada/agent-server` with deus's seams: the in-process deus MCP tools, the tool policy, checkpoint hooks, titles and AAP MCP servers. No DB access, no direct frontend communication; the tools reach the backend through `host-link.ts`, which the backend registers (`startEngine`). Keep blocking work off it: it shares the backend's event loop.

**Rule of thumb:** Needs native Electron API? → Main process. Everything else → Backend (or the engine's seams, for what a turn runs).

### The @zvada/agent-server package (upstream engine + wire)

The agent-server runs on the upstream **[`@zvada/agent-server`](https://github.com/zvadaadam/agent-server)** package (same author as this repo): `/core` is the engine (AgentRuntime + Claude/Codex/ACP harness adapters), `/protocol` the zod wire contract, `/server` the JSON-RPC 2.0 wire (per-session `seq`, bounded replay, quick-ack turns), `/client` the typed consumer the backend uses. The backend serves the engine on an in-process channel (`apps/agent-server/index.ts`: `startEngine`, `beginTurnStart`, `beforeCancel`) and talks to it through `AgentLink` (`apps/backend/src/services/agent/client.ts`); the deus tools' requests and titles are direct calls into the backend (`host-link.ts`).

When debugging agent-server behavior (event shapes, turn admission, cancel semantics, resume, provisioning), **read the package source — you have full access**:

- `node_modules/@zvada/agent-server/src/` — the package ships readable TypeScript source, not compiled JS. This is the fastest reference and always matches the installed version.
- Local clone at `~/Developer/agent-server` (Conductor-managed; work lives on branches/origin, the main checkout is a stale empty worktree) and https://github.com/zvadaadam/agent-server for history, DESIGN.md, and plans/.
- Engine bugs belong upstream (branch + PR there, then bump the pin here); deus consumes the engine protocol natively (no translate layer) — consumer-side behavior lives in the backend's `services/agent/` fold-and-persist path and the frontend's `agentEventFold` projection.

### WebSocket Query Protocol

Single WS connection (`/ws`) using `q:` prefixed JSON frames:

| Frame                                    | Purpose                                                             |
| ---------------------------------------- | ------------------------------------------------------------------- |
| `q:subscribe` / `q:snapshot` / `q:delta` | Reactive data subscriptions (workspaces, stats, sessions, messages) |
| `q:mutate` / `q:mutate_result`           | Sync writes (archiveWorkspace, updateWorkspaceTitle)                |
| `q:command` / `q:command_ack`            | Async actions (sendMessage, stopSession)                            |
| `q:event`                                | Ephemeral push (tool relay, plan-mode)                              |

Resources, mutations, commands, and events are all defined in `shared/events.ts`. Frontend subscribes via `useQuerySubscription()`.

The private workspace package `@deus/runtime-client` (`packages/runtime-client/`)
owns transport, pending operations and subscriptions. Its root entry has no React,
TanStack or app dependencies; `/query` adds a dedicated TanStack Query cache.
`apps/web/src/platform/ws/runtime-client.ts` binds the package to Deus resource
names, cache defaults and the cache-to-runtime lookup. Keep host selection,
credentials, routing, React hooks and domain projections in the app. The package
uses the existing `q:` wire; `@zvada/agent-server/client` serves the separate agent
execution protocol. See `packages/runtime-client/README.md` for the boundary.

The shell selects a host, account and authorization grant; changing any of them
disposes the old runtime and remounts the cache provider. Async flows must retain
their originating client across awaits. Equal resource/parameter subscriptions
share one wire subscription, and equal resource/parameter/query-key bindings
share one cache projection. Agent folds and cloud-direct channels belong to that
same cache and survive reconnects (only disposal drops them). Reconnect restores
reads; it never resends writes. A lost acknowledgment is an `unknown-outcome`, not
permission to retry a command. Correlated ping/pong probes detect silent
connections (30s interval, 10s timeout). When a relay host is replaced,
already-authorized viewers reconnect and authorize again before their
subscriptions resume; a connected tunnel alone is not readiness.

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
  (`codex-homes.ts`, `codexSessionHome`: the user's login, instructions and skills linked in, not
  their history; pruned when its session is deleted). Codex itself accepts
  them in a thread's `config` with no home; when the engine delivers them that
  way, the session homes go.
- **Skills on disk** (`skill-files.ts`) use the Skills CLI layout: files in
  `~/.agents/skills/<name>` (Codex), a symlink in `~/.claude/skills/<name>`
  (Claude), a `.deus-skill.json` marker. Nothing without the marker is replaced
  or removed; a folder is swapped in by two renames, never half written.
  `DEUS_SKILLS_HOME` points it elsewhere (tests, dev).

### Adding a New WS Resource

1. Add resource to `QUERY_RESOURCES` in `shared/events.ts`
2. Add `runQuery` match in `apps/backend/src/services/query-engine.ts`
3. Add invalidation in `agent-event-handler.ts` or relevant route
4. Use `useQuerySubscription(resource, { queryKey, params })` in frontend
5. Set `staleTime: Infinity`, `refetchOnWindowFocus: false` (WS handles freshness)

## Database

Own SQLite at `~/Library/Application Support/com.deus.app/deus.db`. Schema in `shared/schema.ts` — 12 tables: `repositories`, `workspaces`, `sessions`, `messages`, `turns`, `parts`, `compactions`, `paired_devices`, `automations`, `automation_runs`, `extension_installations`, `integration_connections`.

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
bun run test:runtime-client   # packages/runtime-client/test/ (no app aliases or React)
```

Vitest with `vi.mock()` and `vi.hoisted()`. Tests live outside `src/` — never colocate.

`bun run typecheck` covers the web app and `shared/` only. A backend change is
checked by `bun run typecheck:backend` (its tests included), and
`bun run typecheck:all` runs every program.

## Code Style

Detailed conventions for Tailwind v4, components, animations, and performance live in `.claude/skills/deus-code-style/`. Read the relevant file before writing or reviewing code.

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
