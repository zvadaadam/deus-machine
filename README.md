# Command

A desktop IDE for managing multiple parallel AI coding agents. Built for semi-technical users who want to get the job done - treating AI chat as a first-class citizen with code as secondary.

## 🚀 Quick Start

### Development Mode (Web)

```bash
bun run dev:web
```

This starts both backend (Node.js on dynamic port) and frontend (Vite on http://localhost:1420).

### Development Mode (Desktop App)

```bash
bun run dev
```

This runs everything: Vite + Backend + Tauri desktop app.

**⚠️ NEVER run `bun run dev:frontend` alone** - it only starts frontend without backend!

See [DEVELOPMENT.md](DEVELOPMENT.md) for detailed development guide.

## 📁 Architecture

```
┌─────────────────────────────────┐
│   React/Vite Frontend (1420)   │
└────────────┬────────────────────┘
             │ HTTP REST API
┌────────────▼────────────────────┐
│   Rust/Tauri Layer (Desktop)   │
└────────────┬────────────────────┘
             │ Child Process
┌────────────▼────────────────────┐
│   Node.js Backend (Dynamic)    │
│   • Express API Server          │
│   • SQLite Database             │
│   • Claude CLI Management       │
└────────────┬────────────────────┘
             │ stdin/stdout
┌────────────▼────────────────────┐
│   Claude CLI Processes          │
│   (One per session)             │
└─────────────────────────────────┘
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed architecture documentation.

## 🛠 Tech Stack

**Frontend:**

- React 18 + TypeScript
- Vite (dev server)
- Tailwind CSS v4 (OKLCH colors)
- Shadcn UI components
- TanStack Query (data fetching)
- Zustand (state management)

**Backend:**

- Node.js + Express
- SQLite (via better-sqlite3)
- Claude Code CLI integration
- Unix socket IPC (for events)

**Desktop:**

- Tauri 2.0 (Rust + WebView)
- Native OS integrations
- PTY for terminals
- Sidecar process management

## 📦 Prerequisites

- **Node.js** 18+
- **Bun** 1.2+
- **Rust** 1.70+ (for Tauri)
- **Tauri CLI**: `cargo install tauri-cli`

## 🔧 Installation

```bash
# Install dependencies
bun install

# Run in development mode
bun run dev:web        # Web development
bun run dev       # Desktop app development

# Build for production
bun run build           # Frontend only
bun run build:tauri     # Desktop app
```

## 📚 Documentation

- **[ARCHITECTURE.md](ARCHITECTURE.md)** - System architecture and message flow
- **[DEVELOPMENT.md](DEVELOPMENT.md)** - Development guide and best practices
- **[CLAUDE.md](CLAUDE.md)** - Project instructions and guidelines

**Note:** Color system and typography are defined in `src/global.css` using Tailwind CSS v4's `@theme` directive.

## 🎨 Design Principles

We follow design inspiration from Linear, Vercel, Stripe, Airbnb, and Perplexity:

- Beautiful aesthetic design for pro-consumer product
- Consistent paddings (default 16px for density)
- Semantic color system using OKLCH
- Typography scale with proper hierarchy
- Fast animations (200-300ms, ease-out)

## 🏗 Project Structure

```
opendevs/
├── src/                          # React frontend
│   ├── app/                      # App initialization
│   ├── features/                 # Feature modules
│   │   ├── session/              # Session management
│   │   ├── workspace/            # Workspace management
│   │   ├── terminal/             # Terminal integration
│   │   └── browser/              # Browser preview
│   ├── platform/                 # Platform APIs (Tauri)
│   ├── shared/                   # Shared utilities
│   │   ├── api/                  # API client
│   │   ├── config/               # Configuration
│   │   └── lib/                  # Utility functions
│   └── components/               # UI components
│       └── ui/                   # Shadcn components (edit freely - owned code)
├── src-tauri/                    # Rust backend
│   ├── src/
│   │   ├── main.rs               # Tauri app entry
│   │   ├── backend.rs            # Backend process manager
│   │   ├── commands.rs           # Tauri commands (RPC)
│   │   └── events.rs             # Event system
│   └── sidecar/                  # Node.js sidecar
│       └── index.cjs             # Sidecar entry point
├── backend/                      # Express API server
│   ├── server.cjs                # Main server
│   └── lib/                      # Backend modules
│       ├── database.cjs          # SQLite database
│       ├── claude-session.cjs    # Claude CLI management
│       └── sidecar/              # Sidecar IPC
└── tests/                        # Test files
```

## 🧪 Testing

```bash
# Run end-to-end tests
./test-end-to-end.sh
```

## 🌐 Ports

- **Frontend (Vite)**: 1420 (auto-increments if taken)
- **Backend (Node.js)**: Dynamic (50XXX-60XXX range)

Port discovery is automatic:

1. Desktop mode: Tauri `invoke('get_backend_port')`
2. Web dev: `VITE_BACKEND_PORT` env variable
3. Fallback: Port scanning + localStorage cache

## 🤖 AI Agent Workflow

This repo ships with custom Claude Code agents and skills for a structured dev workflow. Everything is tailored to this codebase's architecture (Tauri + React + Node.js + Sidecar).

### Agents

Agents are specialized subagents that Claude auto-delegates to. They run in isolated context with their own tools and model.

| Agent | Model | What it does |
|-------|-------|-------------|
| `code-reviewer` | Sonnet | Quick read-only code review. Has persistent memory — learns patterns over time. |
| `dev` | Opus | TDD developer. Writes failing test first, implements, refactors. Knows the test infrastructure. |
| `deep-reviewer` | Opus | Thorough reviewer. Writes structured review docs to `.context/reviews/` with iteration tracking. |

Agents live in `.claude/agents/` and are auto-loaded by Claude Code.

### Skills (Slash Commands)

Type these in Claude Code to invoke them. **Inline skills** run in your conversation. **Forked skills** spawn a subagent.

#### Quick Commands (inline)

| Command | What it does |
|---------|-------------|
| `/commit` | Analyzes staged changes, writes a good commit message |
| `/pr` | Creates a PR with risk tier, test plan, structured description |
| `/test` | Auto-detects what changed, runs the right test suites |
| `/test backend` | Explicitly run backend tests |
| `/test all` | Run all test suites |
| `/debug [error]` | Traces root cause through the codebase, suggests fix |
| `/risk-tier` | Classifies changed files by risk tier, outputs required checks |

#### Deep Work Commands (forked)

| Command | Agent | What it does |
|---------|-------|-------------|
| `/review` | code-reviewer | Quick code review of changes |
| `/review --staged` | code-reviewer | Review only staged changes |
| `/deep-review` | deep-reviewer | Thorough audit, writes review file to `.context/reviews/` |
| `/dev [task]` | dev | TDD implementation: failing test → pass → refactor |
| `/explore [area]` | Explore | Deep-dive into a codebase area, traces full stack |

### Risk Tiers

Changes are classified by risk tier to determine required checks:

| Tier | Examples | Required checks |
|------|----------|----------------|
| **1 - Critical** | schema.ts, database.ts, sidecar core, Rust main | All tests + cargo test + smoke test + senior review |
| **2 - High** | Routes, services, agents, git.rs, platform | Backend + sidecar + cargo tests + review |
| **3 - Medium** | UI features, stores, global.css | Typecheck + format + visual verification |
| **4 - Low** | Docs, config, tests, Shadcn components | Typecheck + format |

### Typical Dev Session

```
/explore workspace pagination       # understand the area
/dev add cursor-based pagination     # implement with TDD
/test                                # verify tests pass
/review                              # quick check
/commit                              # commit with good message
/deep-review                         # thorough pre-merge audit
/pr                                  # open the PR
```

### Dev ↔ Review Loop

The deep reviewer writes structured review files with status tracking:

1. `/dev [task]` → dev agent implements with TDD
2. `/deep-review` → writes `.context/reviews/review-01.md` (Status: pending)
3. Fix findings → update status to `addressed`
4. `/deep-review` → writes `review-02.md`, references fixed/open items
5. Repeat until Verdict: APPROVE

Skills live in `.claude/skills/` and agents in `.claude/agents/`.

## 📝 Contributing

When working on this project:

- Follow the guidelines in [CLAUDE.md](CLAUDE.md)
- Shadcn components in `src/components/ui/` are owned code - edit freely when needed
- Use semantic colors from the design system (CSS variables in `global.css`)
- Keep animations fast (200-300ms)
- Documentation lives IN the code (use inline comments)

## ⚠️ Important Notes

- This workspace is managed by OpenDevs
- Never edit files outside the workspace directory
- Always run both backend AND frontend together
- Use `bun run dev:web` for web development
- Use `bun run dev` for desktop development

## 📄 License

See LICENSE file for details.
