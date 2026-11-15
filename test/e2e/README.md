# Tests

This directory contains all test files for the Deus application.

## Test Files

### Runtime client network and relay tests

`runtime-client-network.runtime.mjs` starts the real backend and Vite app with an
isolated SQLite database. A desktop browser exercises 700ms latency in each
direction, a 24 KiB/s bandwidth limit, 20 rapid writes, repeated disconnects,
lost and late acknowledgments, missing resources, page reload, and silent
traffic loss with the production 30s + 10s heartbeat deadline; a mobile browser
watches the same data and goes offline (cached reads, refused writes, catching
up). It also checks for duplicate sends, leftover subscriptions, pending
operations and browser errors. Delayed WebSocket frames retain TCP ordering.

```sh
bun run native:node
bunx playwright install chromium
bun run test:e2e:runtime-client
```

The package's faster fault tests run with `bun run test:runtime-client`.

### Account-bound remote access (`remote-access/`)

`remote-access/run.mjs` runs the whole remote-access stack on loopback: a
disposable Postgres container migrated with AGNT's migrations, Deus Cloud from
the linked AGNT worktree, the relay Worker, a Deus backend with an isolated
SQLite database, `@deus/runtime-client`, and the real web app in Chromium. Deus
Cloud sessions are signed with the run's own secret in the shape Deus Cloud
issues after WorkOS sign-in; only the WorkOS page is stood in for (its redirect
returns the same `#token=` fragment). No production service or real account is
used.

```sh
bun run native:node
bunx playwright install chromium
AGNT_WORKSPACE=/path/to/agnt bun run test:e2e:remote-access
```

Docker must be running. It checks, in order:

- Turning on remote access registers the Mac under its signed-in account only, and
  only the process holding the backend's spawn token may hand it an account.
- Deus Cloud gives another account nothing; hosting needs the desktop app plus
  the Mac's own secret.
- The relay refuses sockets without a valid, unused ticket for that machine and
  role, and refuses even a correctly signed ticket for another account once a
  machine is pinned. In the real Durable Object runtime, two accounts racing to
  host one unclaimed machine, and one ticket presented twice at once, each admit
  exactly one socket; a ticket that expires in transit is refused.
- One-use pairing approves a device for the relay-verified account.
- Two devices read, subscribe, write and answer heartbeat probes through the relay.
- A slow Deus Cloud (700ms each way) only slows dialing.
- A six-second authentication delay redials with a fresh ticket without revoking.
- An offline Mac keeps viewers connected but blocks writes; new viewers wait;
  pairing is refused with "This computer is offline" on the socket; a restarted
  Mac keeps its machine id and viewers reconnect with the same grants.
- A Deus Cloud outage leaves live connections working; new dials resume after.
- A relay restart keeps the machine's owner; the Mac, its viewers and a viewer
  that dialed during the outage reconnect.
- Signing the Mac into another account cuts the first account off; signing back
  reuses its approvals without a new code.
- Revoking one device ends its access and old grant; the other keeps working.
- Two computers in one account approve their own devices; a grant opens only its
  own computer.
- Direct LAN access still needs pairing, and settings never serve machine secrets.
- Removing a computer from the account keeps it off through a restart and retires
  its relay grants, leaving the account's other computer; turning remote access on
  registers it anew.
- In the browser: scanning the QR while signed out (sign in, approve with the
  link's code, connect, secrets scrubbed from the URL); reload and a new tab
  reconnect without a code; reopening a QR link on an approved browser leaves its
  code unspent; `/connect` signs in from its own page, lists the account's
  computers, and says when Deus Cloud is unreachable until Try again succeeds;
  another account, even holding the
  Mac's code, sees "This computer isn't on your account"; manual approval
  survives a pairing socket that closes with no answer and a double submit,
  pairing once; a QR scanned while the Mac is offline says so, and Try again
  pairs once it is back; sign-in without a redirect loop; the approval page and
  the Mac's dialog both name the computer with the same id fingerprint; the
  Mac's Remote access settings with the QR, which shows a new code once a
  device has paired with the old one.

`REMOTE_ACCESS_E2E_BROWSER_ONLY=1` skips to the browser checks. Logs, Worker
state, the run's databases and `results.json` go to `.context/remote-access/`,
with mobile and desktop screenshots beside them. The relay can still read `q:`
frames: this verifies account admission, not end-to-end encryption.

### Cloud workspaces against a scripted platform (`cloud/`)

Two journeys run a cloud workspace in the real web app, in Chromium, against
`cloud/platform.mjs`: a local HTTP + WebSocket server on `127.0.0.1` that stands
in for the Deus platform. It mints session tokens (checking the Deus Cloud
bearer), lists an organization's sessions, accepts session metadata, and holds
each session's socket (a `session.snapshot` on connect, `pong` for `ping`, every
command recorded). Every frame it sends is validated against `@deus-hq/api`'s
`WebSocketEventSchema` and throws if invalid, so it can only say what the real
platform may say. The journeys script the platform's side of a turn: the
prompt's echo (under the engine's `echo-<turnId>` ids), a streamed reply, a
question, the end of the turn, and dropped sockets.

- `cloud/mac-lane.browser.mjs`, the desktop's lane: a real backend (isolated
  SQLite database with two cloud workspaces) holds the platform's socket, and
  the app follows the backend's streams. It checks the transcript from the
  snapshot; the sandbox address and simulator status on their streams; one
  `message.send` per prompt; the reply shown while it is typed; a second client
  that hovers and then opens the chat mid-reply, and that is reset and reads
  again, shows the reply typed so far once; the question card and its
  `elicitation.respond`; one prompt bubble at the end; the page equal to a fresh
  read of the database; each row once after the platform socket drops; and a
  client opening a chat the backend restored mid-reply sees the part as it
  stands, then the tokens after it.
- `cloud/direct-lane.browser.mjs`, the hosted web's lane (`VITE_CLOUD_DIRECT=1`,
  no backend): the browser lists the platform's sessions, mints a token from
  its web session and holds the socket itself. It checks the sidebar, the
  snapshot, the side streams, `message.send`, streaming, the question, the
  session list read again when the turn ends, and each row once after a
  dropped socket.

Each journey also fails on a page error, and on any request the platform does
not serve beyond the short allow-list at the top of the file (the Mac lane's
backend reads `GET /models`, `GET /workspaces/:id` and `GET /sessions/:id`,
which are answered 404).

```sh
bun run native:node
bunx playwright install chromium
bun run test:e2e:cloud
```

The journeys run under `node --import tsx` (Playwright hangs under Bun); the Mac
lane's backend needs `better-sqlite3` built for Node (`native:node`). Screenshots, the backend log and
the run's database go to `.context/cloud-e2e/`. No sandbox, model, Deus Cloud
or production service is involved, so this does not cover a live sandbox or
the real platform's behaviour, only the app's side of its contract.

### `workspace-location.browser.mjs`

Runs the sidebar header's "where workspaces run" switcher in the real web app
against the real backend. An isolated database holds one local and one cloud
workspace in the same repository; the cloud is the scripted platform from
`cloud/platform.mjs`, so the backend is signed in to Deus Cloud. It checks the
filtered list, the menu, ⌃1/⌃2, following a selection opened by URL, restoring
the last selection per location, persistence across a reload, the Home
composer's default, and the 390×844 sheet. No sandbox or model call.

```bash
node --import tsx test/e2e/workspace-location.browser.mjs
```

Screenshots of the open menu (local, cloud, mobile) go to `.context/workspace-location`.

### `controls.browser.mjs`

Runs the shared buttons, joined controls, menus, selects and tabs in an isolated
browser. Checks disabled actions, stable press geometry, circular overrides,
keyboard focus/menu behavior, independent tab lifetimes, reduced motion and touch.
No backend or provider credentials are needed.

```bash
bun test/e2e/controls.browser.mjs
```

Light, dark and mobile screenshots are saved under `.context/controls-ui` and
uploaded by CI alongside the workspace usability/layout screenshots.

### `provider-accounts.browser.mjs`

Runs Settings → AI Providers' cloud accounts in an isolated browser against a
fake cloud API: Claude and Codex keys, several Claude subscriptions, replacing
a token or key, defaults, the device sign-in (cancel, add, reconnect, retry),
an identity change, and that no secret stays in the query cache. No backend,
login or provider call is needed.

```bash
bun test/e2e/provider-accounts.browser.mjs
```

### `model-picker.browser.mjs`

Runs the composer's one picker for agent, model and thinking effort in an
isolated browser, with the engine's own catalog: the trigger's phrase, the
menu's agents, models and levels (marks on the right), the level fitted when
the model changes, a model with no thinking control, the keyboard, another
agent's model in a started chat (a new chat), and a phone's width. No backend
or provider call is needed.

```bash
bun test/e2e/model-picker.browser.mjs
```

### `environment-secrets.browser.mjs`

Runs the real Environment settings components through both the desktop backend
proxy and direct web API against AGNT's authenticated routes and encrypted
Postgres store. Native sign-in, provider metadata and GitHub discovery are fixtures;
public recipe and secret writes, ownership checks, and local repository files are real.
It checks file-versus-saved precedence, local/cloud overrides, file publication without
secrets, malformed-file errors, unsaved-edit guards, all four secret scopes,
organization/account switching, replacement/deletion, mobile layout, and absence of
secret values from query/mutation caches. The agent setup action is checked through
its Local/Cloud request and selected model; this harness does not run an agent turn.

Create and migrate a disposable Postgres database using the linked AGNT checkout,
then run from the Deus worktree:

```bash
AGNT_WORKSPACE=/path/to/agnt \
SECRET_TEST_DATABASE_URL=postgres://agnt:agnt@localhost:5432/secrets_test \
bun test/e2e/environment-secrets.browser.mjs
```

The test starts isolated HTTP/Vite servers and removes its database rows and
temporary session tokens on exit. Screenshots go to `.context/environment-secrets-ui`.
It does not start or restart the user's Electron app. AGNT also provides an opt-in
`tests/integration/environment-secrets.vm.ts` test for real E2B checkout, preparation,
secret injection, an HTTP app, pause/resume, and VM cleanup.

### `project-environment.runtime.mjs`

Runs the full app against a disposable local backend database. It saves the recipe
through Settings, commits it in a temporary Git repository, creates a real worktree,
verifies dotenv copying and the Setup log, then clicks Run and verifies the real
terminal process received the local variable. No provider login or inference is needed.

Start the app from this worktree with Node 22 and isolated state:

```bash
mkdir -p .context/project-environment-app
DATABASE_PATH="$PWD/.context/project-environment-app/deus.db" \
AGNT_API_KEY= DEUS_CLOUD_AGNT_API_KEY= bun run dev:web
```

Then use the URLs printed by that dev process:

```bash
DEUS_TEST_BACKEND_URL=http://127.0.0.1:BACKEND_PORT \
DEUS_TEST_WEB_URL=http://localhost:VITE_PORT \
bun test/e2e/project-environment.runtime.mjs
```

The test closes its browser and retains the disposable repository, database and
screenshots in `.context/project-environment-app` for inspection. Stop that isolated
dev process after testing to release its terminals. Do not point this harness at the
user's desktop backend or normal database.

### `e2e-flow.test.cjs`

Comprehensive end-to-end test suite that verifies:

- ✅ Backend health check
- ✅ Workspace creation (new workspace, not existing)
- ✅ Message sending
- ✅ Claude CLI integration
- ✅ Database persistence
- ✅ State management

**Run the test:**

```bash
# Backend must be running first!
bun run dev:web  # Start in separate terminal

# Then run test (use the backend port from dev:web output)
export BACKEND_PORT=60068  # Use actual port from backend
bun run test:e2e

# Or specify port inline
BACKEND_PORT=60068 bun run test:e2e
```

**Duration**: ~20-30 seconds

**What it does:**

1. Creates a fresh workspace in the deus-machine repository
2. Waits for workspace to become ready
3. Sends a test message to Claude
4. Verifies Claude responds
5. Checks database storage
6. Archives the test workspace (cleanup)

## Requirements

- Backend must be running
- Database must be accessible at `~/Library/Application Support/com.deus.app/deus.db`

## Test Coverage

- ✅ HTTP API endpoints
- ✅ Message flow (User → Backend → Claude → Response)
- ✅ Database storage (sessions, messages, workspaces)
- ✅ State management (working/idle states)
- ✅ Cross-repository Claude CLI spawning
- ⚠️ Socket events (requires `socket.io-client` package)

## Adding New Tests

When creating new tests, follow these patterns:

1. **Name**: `feature-name.test.cjs`
2. **Structure**: Similar to `e2e-flow.test.cjs`
3. **Cleanup**: Always clean up test data
4. **Documentation**: Update this README

## CI/CD

To add tests to CI/CD pipeline:

```json
{
  "scripts": {
    "test": "node tests/e2e-flow.test.cjs",
    "test:watch": "nodemon tests/e2e-flow.test.cjs"
  }
}
```
