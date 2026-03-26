# Deus

A desktop IDE for managing multiple parallel AI coding agents. Built for semi-technical users who want to get the job done - treating AI chat as a first-class citizen with code as secondary.

## Quick Start

### Development Mode (Web)

```bash
bun run dev:web
```

This starts both backend (Node.js on dynamic port) and frontend (Vite on http://localhost:1420).

### Development Mode (Desktop App)

```bash
bun run dev
```

This runs everything: Vite + Backend + Electron desktop app.

**Never run `bun run dev:frontend` alone** - it only starts frontend without backend!

See [DEVELOPMENT.md](DEVELOPMENT.md) for detailed development guide.

## Architecture

```
┌─────────────────────────────────┐
│   React/Vite Frontend (1420)   │
└───────┬─────────────┬───────────┘
        │             │ HTTP REST API + WebSocket
        │  ┌──────────▼────────────────────┐
        │  │   Node.js Backend (Dynamic)   │
        │  │   • Hono API Server            │
        │  │   • SQLite Database            │
        │  │   • Workspace management       │
        │  │   • Sidecar socket relay       │
        │  └──────────┬────────────────────┘
        │             │ WebSocket (JSON-RPC 2.0)
        │  ┌──────────▼────────────────────┐
        │  │   Sidecar (Claude Agent SDK)  │
        │  │   (One per app instance)       │
        │  └───────────────────────────────┘
        │ IPC (preload bridge)
┌───────▼─────────────────────────┐
│   Electron Main Process         │
│   • Window management            │
│   • PTY (node-pty)               │
│   • BrowserView management       │
└──────────────────────────────────┘
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed architecture documentation.

## Tech Stack

**Frontend:**

- React 18 + TypeScript
- Vite (dev server)
- Tailwind CSS v4 (OKLCH colors)
- Shadcn UI components
- TanStack Query (data fetching)
- Zustand (state management)

**Backend:**

- Node.js + Hono
- SQLite (via better-sqlite3)
- Claude Agent SDK integration
- Unix socket IPC (for sidecar)

**Desktop:**

- Electron (cross-platform)
- Native OS integrations
- node-pty for terminals
- BrowserView for web automation
- Sidecar process management

## Prerequisites

- **Node.js** 22+
- **Bun** 1.2+

## Installation

```bash
# Install dependencies
bun install

# Run in development mode
bun run dev:web        # Web development
bun run dev            # Desktop app development

# Build for production
bun run build:all      # Build everything
bun run package:mac    # Package macOS app
```

## Documentation

- **[ARCHITECTURE.md](ARCHITECTURE.md)** - System architecture and message flow
- **[DEVELOPMENT.md](DEVELOPMENT.md)** - Development guide and best practices
- **[CLAUDE.md](CLAUDE.md)** - Project instructions and guidelines

**Note:** Color system and typography are defined in `apps/web/src/global.css` using Tailwind CSS v4's `@theme` directive.

## Design Principles

We follow design inspiration from Linear, Vercel, Stripe, Airbnb, and Perplexity:

- Beautiful aesthetic design for pro-consumer product
- Consistent paddings (default 16px for density)
- Semantic color system using OKLCH
- Typography scale with proper hierarchy
- Fast animations (200-300ms, ease-out)

## Project Structure

```
deus/
├── apps/
│   ├── desktop/                 # Electron main + preload
│   │   ├── main/
│   │   │   ├── index.ts             # App entry, window lifecycle
│   │   │   ├── backend-process.ts   # Backend child process manager
│   │   │   ├── sidecar-process.ts   # Sidecar manager + socket relay
│   │   │   ├── pty-handlers.ts      # Terminal (node-pty)
│   │   │   ├── browser-views.ts     # BrowserView management
│   │   │   └── native-handlers.ts   # OS integrations (dialogs, theme)
│   │   └── preload/                 # Electron preload scripts
│   ├── web/src/                 # React frontend
│   │   ├── app/                 # App initialization
│   │   ├── features/            # Feature modules
│   │   │   ├── session/         # Session management
│   │   │   ├── workspace/       # Workspace management
│   │   │   ├── terminal/        # Terminal integration
│   │   │   └── browser/         # Browser automation
│   │   ├── platform/            # Platform APIs (Electron IPC)
│   │   ├── shared/              # Shared utilities
│   │   │   ├── api/             # API client
│   │   │   ├── config/          # Configuration
│   │   │   └── lib/             # Utility functions
│   │   └── components/          # UI components
│   │       └── ui/              # Shadcn components (edit freely)
│   ├── backend/                 # Node.js API server
│   │   ├── src/
│   │   │   ├── routes/              # REST endpoints
│   │   │   ├── services/            # Business logic
│   │   │   └── db/                  # Database queries
│   │   └── server.cjs               # Entry point
│   └── sidecar/                 # Claude Agent SDK process
│       ├── index.ts                 # JSON-RPC server over WebSocket
│       └── agents/                  # Agent handlers
├── shared/                      # Shared types and constants
└── tests/                       # Test files
```

## Testing

```bash
bun run test:backend       # Backend tests
bun run test:sidecar:unit  # Sidecar unit tests
bun run test:sidecar:e2e   # Sidecar E2E tests
bun run test               # All tests
```

## Ports

- **Frontend (Vite)**: 1420 (auto-increments if taken)
- **Backend (Node.js)**: Dynamic (50XXX-60XXX range)

Port discovery is automatic:

1. Desktop mode: Electron IPC `getBackendPort()`
2. Web dev: `VITE_BACKEND_PORT` env variable
3. Fallback: Default port 3333

## AI Agent Workflow

This repo ships with custom Claude Code agents and skills for a structured dev workflow. Everything is tailored to this codebase's architecture (Electron + React + Node.js + Sidecar).

### Agents

Agents are specialized subagents that Claude auto-delegates to. They run in isolated context with their own tools and model.

| Agent           | Model  | What it does                                                     |
| --------------- | ------ | ---------------------------------------------------------------- |
| `code-reviewer` | Sonnet | Quick read-only code review. Has persistent memory.              |
| `dev`           | Opus   | TDD developer. Writes failing test first, implements, refactors. |
| `deep-reviewer` | Opus   | Thorough reviewer. Writes structured review docs.                |

### Skills (Slash Commands)

| Command           | What it does                                                   |
| ----------------- | -------------------------------------------------------------- |
| `/commit`         | Analyzes staged changes, writes a good commit message          |
| `/pr`             | Creates a PR with risk tier, test plan, structured description |
| `/test`           | Auto-detects what changed, runs the right test suites          |
| `/debug [error]`  | Traces root cause through the codebase, suggests fix           |
| `/review`         | Quick code review of changes                                   |
| `/deep-review`    | Thorough audit, writes review file                             |
| `/dev [task]`     | TDD implementation: failing test -> pass -> refactor           |
| `/explore [area]` | Deep-dive into a codebase area                                 |

## Contributing

When working on this project:

- Follow the guidelines in [CLAUDE.md](CLAUDE.md)
- Shadcn components in `apps/web/src/components/ui/` are owned code - edit freely
- Use semantic colors from the design system (CSS variables in `global.css`)
- Keep animations fast (200-300ms)
- Documentation lives IN the code (use inline comments)

## Important Notes

- This workspace is managed by Deus
- Never edit files outside the workspace directory
- Always run both backend AND frontend together
- Use `bun run dev:web` for web development
- Use `bun run dev` for desktop development

## License

See LICENSE file for details.
