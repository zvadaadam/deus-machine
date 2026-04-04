# Tests

This directory contains all test files for the Deus application.

## Test Files

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
