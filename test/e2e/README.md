# Tests

This directory contains all test files for the Deus application.

## Test Files

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
