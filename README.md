# OpenDevs

A desktop IDE for managing multiple parallel AI coding agents. Built for semi-technical users who want to get the job done - treating AI chat as a first-class citizen with code as secondary.

## 🚀 Quick Start

### Development Mode (Web)
```bash
npm run dev:full
```
This starts both backend (Node.js on dynamic port) and frontend (Vite on http://localhost:1420).

### Development Mode (Desktop App)
```bash
npm run tauri:dev
```
This runs everything: Vite + Backend + Tauri desktop app.

**⚠️ NEVER run `npm run dev` alone** - it only starts frontend without backend!

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
- **Rust** 1.70+ (for Tauri)
- **Tauri CLI**: `cargo install tauri-cli`

## 🔧 Installation

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev:full        # Web development
npm run tauri:dev       # Desktop app development

# Build for production
npm run build           # Frontend only
npm run tauri:build     # Desktop app
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
conductor/
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
- Use `npm run dev:full` for web development
- Use `npm run tauri:dev` for desktop development

## 📄 License

See LICENSE file for details.
