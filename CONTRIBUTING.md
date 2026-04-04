# Contributing to Deus

Thanks for your interest in contributing to Deus! This document covers everything you need to get started.

## Prerequisites

- **Node.js** 22+
- **Bun** 1.2+ (package manager — never use npm or yarn)

## Setup

```bash
git clone https://github.com/zvadaadam/deus-machine.git
cd deus-machine
bun install
```

## Development

```bash
# Web development (recommended for most work)
bun run dev:web

# Desktop app development
bun run dev
```

Both commands start the full stack (frontend + backend + agent-server). Never run `bun run dev:frontend` alone — it won't have a backend.

See [DEVELOPMENT.md](DEVELOPMENT.md) for detailed setup, port configuration, and troubleshooting.

## Project Structure

```text
apps/
  desktop/        Electron main process (window lifecycle, native OS)
  web/src/        React frontend (features/, components/, shared/)
  backend/        Node.js API server (Hono, SQLite, agent coordination)
  agent-server/   Stateless Claude/Codex SDK wrapper (JSON-RPC 2.0)
shared/           Types and constants shared across apps
packages/         Internal packages (screen-studio)
```

## Code Style

- **TypeScript** everywhere — strict mode in backend and agent-server
- **Prettier + ESLint** run on pre-commit via Husky
- **Tailwind CSS v4** with OKLCH color system — no hardcoded colors
- **Shadcn UI** components in `apps/web/src/components/ui/` are owned code — edit freely

### Key Conventions

- **State management**: Zustand for UI state, TanStack Query for server state — never mix them
- **Pattern matching**: Use `ts-pattern` for switch/case on discriminated unions
- **Animations**: 200-300ms, ease-out-quart. Only animate `transform` and `opacity`
- **Documentation**: Lives in the code as comments, not in separate markdown files
- **Components**: Feature-scoped by default (`features/{name}/ui/`), promote to `shared/components/` only when a second feature needs it

## Testing

```bash
bun run test                    # All tests
bun run test:backend            # Backend unit tests
bun run test:agent-server:unit  # Agent-server unit tests
```

Tests live in dedicated test directories (`apps/backend/test/`, `apps/agent-server/test/`), not colocated with source code.

## Submitting Changes

1. Fork the repo and create a branch from `main`
2. Make your changes — keep PRs focused on a single concern
3. Add tests for new functionality
4. Run `bun run test` to make sure nothing is broken
5. Open a pull request against `main`

### PR Guidelines

- Keep the title short (under 70 characters)
- Include a summary of what changed and why
- Add a test plan describing how to verify the changes
- Link any related issues

### Commit Messages

- Use conventional style: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`
- Focus on the "why" not the "what"
- Keep the first line under 72 characters

## Architecture Overview

Deus is an Electron + React + Node.js monorepo with three main processes:

1. **Electron main** — thin desktop shell (windows, native dialogs, process lifecycle)
2. **Node.js backend** — all business logic (database, API, agent coordination, tool relay)
3. **Agent-server** — stateless SDK wrapper (Claude/Codex integration, canonical event emission)

Data flows through WebSocket push subscriptions (`q:subscribe` / `q:delta` / `q:snapshot`). The agent-server streams canonical events to the backend, which persists them and pushes updates to the frontend. See [CLAUDE.md](CLAUDE.md) for the full architecture documentation.

## License

By contributing, you agree that your contributions will be licensed under the [Elastic License 2.0](LICENSE).
