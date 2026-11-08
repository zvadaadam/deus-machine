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
  Mac's Remote access settings with the QR.

`REMOTE_ACCESS_E2E_BROWSER_ONLY=1` skips to the browser checks. Logs, Worker
state, the run's databases and `results.json` go to `.context/remote-access/`,
with mobile and desktop screenshots beside them. The relay can still read `q:`
frames: this verifies account admission, not end-to-end encryption.

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
DEUS_AAP_PID_JOURNAL="$PWD/.context/project-environment-app/aap-pids.txt" \
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
