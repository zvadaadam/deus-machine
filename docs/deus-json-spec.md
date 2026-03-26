# deus.json Specification

Version: 1
Last updated: 2026-02-18

The `deus.json` manifest tells the Deus orchestrator how to set up, run, build, test, and manage workspaces. It lives at the root of every workspace/repository.

---

## Schema Overview

```json
{
  "$schema": "https://deus.dev/schemas/deus.json",
  "version": 1,
  "name": "My Project",

  "scripts": {
    "setup": "./scripts/setup.sh",
    "run": "./scripts/dev.sh"
  },
  "runScriptMode": "nonconcurrent",

  "requires": {
    "node": ">= 22",
    "bun": ">= 1.2"
  },

  "env": {
    "NODE_ENV": "development"
  },

  "lifecycle": {
    "setup": "./scripts/setup.sh",
    "archive": "./scripts/archive.sh"
  },

  "tasks": {
    "dev": {
      "command": "./scripts/dev.sh",
      "description": "Start frontend + backend dev servers",
      "icon": "play",
      "persistent": true,
      "mode": "nonconcurrent"
    },
    "test": "bun run test",
    "build": {
      "command": "bun run build",
      "icon": "hammer",
      "depends": ["build:sidecar"]
    }
  }
}
```

---

## Field Reference

### Top-level fields

| Field     | Type     | Required | Default | Description                            |
| --------- | -------- | -------- | ------- | -------------------------------------- |
| `$schema` | `string` | No       | —       | JSON schema URL for editor validation  |
| `version` | `number` | Yes      | —       | Manifest schema version. Currently `1` |
| `name`    | `string` | No       | —       | Human-readable project name            |

### `scripts` (backwards-compatible)

Legacy fields consumed by the current Deus app. Keep these for backwards compatibility.

| Field           | Type     | Required | Description                                                |
| --------------- | -------- | -------- | ---------------------------------------------------------- |
| `scripts.setup` | `string` | No       | Shell command or script path run when workspace is created |
| `scripts.run`   | `string` | No       | Shell command or script path for the main dev server       |

### `runScriptMode`

| Field           | Type                              | Required | Default        | Description                                                          |
| --------------- | --------------------------------- | -------- | -------------- | -------------------------------------------------------------------- |
| `runScriptMode` | `"concurrent" \| "nonconcurrent"` | No       | `"concurrent"` | Whether the run script allows concurrent execution across workspaces |

### `requires`

Runtime/tool version constraints. Deus validates these before running setup.

| Field             | Type     | Example     | Description                |
| ----------------- | -------- | ----------- | -------------------------- |
| `requires.node`   | `string` | `">= 22"`   | Node.js version constraint |
| `requires.bun`    | `string` | `">= 1.2"`  | Bun version constraint     |
| `requires.rust`   | `string` | `">= 1.75"` | Rust toolchain version     |
| `requires.python` | `string` | `">= 3.12"` | Python version             |
| `requires.go`     | `string` | `">= 1.22"` | Go version                 |
| `requires.<tool>` | `string` | `">= x.y"`  | Any runtime or tool        |

Version strings use semver range syntax: `">= 1.2"`, `"^22.0"`, `"~3.12"`, `"1.2.19"`.

### `env`

Environment variables set before any script execution.

```json
"env": {
  "NODE_ENV": "development",
  "LOG_LEVEL": "debug"
}
```

Values are strings. Deus sets these as process environment variables before running lifecycle hooks and tasks.

### `lifecycle`

Automatic hooks triggered by workspace state changes. These are NOT shown as clickable buttons in the UI.

| Field               | Type     | Description                                                          |
| ------------------- | -------- | -------------------------------------------------------------------- |
| `lifecycle.setup`   | `string` | Run once when workspace is created. Install deps, copy configs, etc. |
| `lifecycle.archive` | `string` | Run when workspace is archived/deleted. Cleanup, save state, etc.    |

### `tasks`

Named commands that appear as clickable buttons in the Deus UI. Each task can be a **string** (shorthand) or an **object** (full config).

#### String shorthand

```json
"tasks": {
  "test": "bun run test",
  "lint": "bun run lint",
  "format": "bun run format"
}
```

String tasks use default settings: no icon, not persistent, no dependencies.

#### Object form

```json
"tasks": {
  "dev": {
    "command": "./scripts/dev.sh",
    "description": "Start frontend + backend dev servers",
    "icon": "play",
    "persistent": true,
    "mode": "nonconcurrent",
    "depends": [],
    "platform": ["macos", "linux"],
    "env": {
      "DEBUG": "true"
    }
  }
}
```

| Field         | Type                              | Required | Default        | Description                                                          |
| ------------- | --------------------------------- | -------- | -------------- | -------------------------------------------------------------------- |
| `command`     | `string`                          | Yes      | —              | Shell command or script path to execute                              |
| `description` | `string`                          | No       | —              | Human-readable description shown in UI tooltip                       |
| `icon`        | `string`                          | No       | `"terminal"`   | Lucide icon name (see icon reference below)                          |
| `persistent`  | `boolean`                         | No       | `false`        | If `true`, task is a long-running process (dev server, watcher)      |
| `mode`        | `"concurrent" \| "nonconcurrent"` | No       | `"concurrent"` | Whether this task can run concurrently across workspaces             |
| `depends`     | `string[]`                        | No       | `[]`           | Task names that must complete before this task starts                |
| `platform`    | `string[]`                        | No       | all            | Restrict to platforms: `"macos"`, `"linux"`, `"windows"`             |
| `env`         | `object`                          | No       | `{}`           | Additional env vars for this task only (merged with top-level `env`) |

---

## Icon Reference

Icons use names from [lucide-react](https://lucide.dev/icons/), which is already a project dependency. The Deus UI renders these as icon buttons next to each task.

| Icon name      | Lucide component | Use case                            |
| -------------- | ---------------- | ----------------------------------- |
| `play`         | `Play`           | Dev server, run, start, serve       |
| `hammer`       | `Hammer`         | Build, compile, bundle              |
| `check-circle` | `CheckCircle`    | Test, validate, verify              |
| `search-code`  | `SearchCode`     | Lint, typecheck, static analysis    |
| `paintbrush`   | `Paintbrush`     | Format, prettify, style             |
| `rocket`       | `Rocket`         | Deploy, release, publish            |
| `terminal`     | `Terminal`       | Generic script, shell command       |
| `package`      | `Package`        | Bundle, package, sub-builds         |
| `monitor`      | `Monitor`        | Preview, visual inspection          |
| `book-open`    | `BookOpen`       | Documentation, storybook            |
| `database`     | `Database`       | Migrations, seed, DB operations     |
| `shield`       | `Shield`         | Security audit, vulnerability check |
| `refresh-cw`   | `RefreshCw`      | Clean, reset, rebuild               |
| `globe`        | `Globe`          | Serve, expose, public URL           |

When no icon is specified, the UI defaults to `terminal`.

---

## Deus Environment Variables

Deus sets these environment variables automatically when running scripts:

| Variable              | Description                                    | Example                       |
| --------------------- | ---------------------------------------------- | ----------------------------- |
| `DEUS_ROOT_PATH`      | Path to the root repository (not the worktree) | `/Users/me/projects/my-app`   |
| `DEUS_WORKSPACE_PATH` | Path to this workspace's worktree              | `/Users/me/.deus/workspace-1` |
| `DEUS_WORKSPACE_ID`   | Unique workspace identifier                    | `ws_abc123`                   |

Scripts can use these to locate shared configs, copy files from the root repo, etc.

---

## Examples

### Node.js (Bun)

```json
{
  "$schema": "https://deus.dev/schemas/deus.json",
  "version": 1,
  "name": "my-api",
  "scripts": { "setup": "bun install", "run": "bun run dev" },
  "runScriptMode": "concurrent",
  "requires": { "node": ">= 22", "bun": ">= 1.2" },
  "lifecycle": { "setup": "bun install" },
  "tasks": {
    "dev": { "command": "bun run dev", "icon": "play", "persistent": true },
    "build": { "command": "bun run build", "icon": "hammer" },
    "test": "bun run test",
    "lint": "bun run lint",
    "format": "bun run format"
  }
}
```

### Python (uv)

```json
{
  "$schema": "https://deus.dev/schemas/deus.json",
  "version": 1,
  "name": "ml-service",
  "scripts": { "setup": "uv sync", "run": "uv run uvicorn app:main --reload" },
  "runScriptMode": "concurrent",
  "requires": { "python": ">= 3.12", "uv": ">= 0.4" },
  "lifecycle": { "setup": "uv sync" },
  "tasks": {
    "dev": { "command": "uv run uvicorn app:main --reload", "icon": "play", "persistent": true },
    "test": "uv run pytest",
    "lint": "uv run ruff check .",
    "format": "uv run ruff format ."
  }
}
```

### Rust

```json
{
  "$schema": "https://deus.dev/schemas/deus.json",
  "version": 1,
  "name": "my-cli",
  "scripts": { "setup": "cargo build", "run": "cargo run" },
  "runScriptMode": "nonconcurrent",
  "requires": { "rust": ">= 1.75" },
  "lifecycle": { "setup": "cargo build" },
  "tasks": {
    "dev": { "command": "cargo run", "icon": "play" },
    "build": { "command": "cargo build --release", "icon": "hammer" },
    "test": "cargo test",
    "lint": "cargo clippy -- -D warnings",
    "format": "cargo fmt"
  }
}
```

### Monorepo (Turborepo)

```json
{
  "$schema": "https://deus.dev/schemas/deus.json",
  "version": 1,
  "name": "my-monorepo",
  "scripts": { "setup": "bun install", "run": "bun run dev" },
  "runScriptMode": "concurrent",
  "requires": { "node": ">= 22", "bun": ">= 1.2" },
  "lifecycle": { "setup": "bun install" },
  "tasks": {
    "dev": { "command": "bunx turbo dev", "icon": "play", "persistent": true },
    "build": { "command": "bunx turbo build", "icon": "hammer" },
    "test": { "command": "bunx turbo test", "icon": "check-circle" },
    "lint": "bunx turbo lint",
    "format": "bun run format"
  }
}
```

### Full-stack Electron (Deus IDE)

```json
{
  "$schema": "https://deus.dev/schemas/deus.json",
  "version": 1,
  "name": "Deus IDE",
  "scripts": { "setup": "./scripts/deus-setup.sh", "run": "./scripts/dev.sh" },
  "runScriptMode": "nonconcurrent",
  "requires": { "node": ">= 22", "bun": ">= 1.2" },
  "env": { "NODE_ENV": "development" },
  "lifecycle": { "setup": "./scripts/deus-setup.sh" },
  "tasks": {
    "dev": {
      "command": "./scripts/dev.sh",
      "description": "Start frontend + backend dev servers (web mode)",
      "icon": "play",
      "persistent": true,
      "mode": "nonconcurrent"
    },
    "dev:desktop": {
      "command": "bun run dev",
      "description": "Start full Electron desktop app",
      "icon": "monitor",
      "persistent": true,
      "mode": "nonconcurrent",
      "depends": ["build:sidecar"]
    },
    "build": {
      "command": "bun run build",
      "icon": "hammer",
      "depends": ["build:sidecar"]
    },
    "build:desktop": {
      "command": "bun run build:all",
      "description": "Build Electron desktop binary",
      "icon": "package",
      "depends": ["build:sidecar"]
    },
    "build:sidecar": { "command": "bun run build:sidecar", "icon": "package" },
    "test": "bun run test",
    "test:backend": "bun run test:backend",
    "test:sidecar": "bun run test:sidecar:unit",
    "test:e2e": "bun run test:sidecar:e2e",
    "typecheck": { "command": "bun run typecheck", "icon": "search-code" },
    "lint": { "command": "bun run lint", "icon": "search-code" },
    "format": { "command": "bun run format", "icon": "paintbrush" },
    "storybook": {
      "command": "bun run storybook",
      "description": "Launch Storybook component browser",
      "icon": "book-open",
      "persistent": true
    }
  }
}
```

---

## Legacy Field Mapping

For backwards compatibility, always include the `scripts` and `runScriptMode` top-level fields alongside the new `lifecycle` and `tasks` fields.

| Legacy field      | Maps to                  |
| ----------------- | ------------------------ |
| `scripts.setup`   | `lifecycle.setup`        |
| `scripts.run`     | Main `tasks.dev.command` |
| `scripts.archive` | `lifecycle.archive`      |
| `runScriptMode`   | `tasks.dev.mode`         |

The current Deus app reads `scripts.*` and `runScriptMode`. Future versions will read `lifecycle` and `tasks` directly. Including both ensures forwards and backwards compatibility.

---

## Generating deus.json

Use the Claude Code skill to auto-generate a manifest:

```
/generate-deus-json [path]
```

The skill:

1. Imports from existing Deus (`deus.json`) or Codex (`environment.toml`) configs
2. Detects project type from files (`package.json`, `Cargo.toml`, `pyproject.toml`, etc.)
3. Detects package manager from lockfiles
4. Extracts scripts and maps them to tasks with appropriate icons
5. Merges imported + detected (imported takes precedence)
6. Writes `deus.json`
