---
name: generate-deus-json
description: Generate a deus.json manifest for a project. Auto-detects tech stack, package manager, scripts, and maps them to tasks with icons. Can import from existing Codex configs. Use when setting up a new workspace or migrating from another tool.
argument-hint: "[path to project root, default: .]"
---

Generate a `deus.json` manifest for the project at the given path.

$ARGUMENTS

## Context

Project root to analyze (default: current directory):
!`ls package.json Cargo.toml pyproject.toml go.mod composer.json Gemfile build.gradle pom.xml Makefile 2>/dev/null || echo "No standard project files found"`

Existing configs to import from:
!`ls deus.json 2>/dev/null || echo "No existing deus config"`
!`ls .codex/environments/environment.toml 2>/dev/null || echo "No Codex environment.toml"`

Package manager lockfiles:
!`ls bun.lock bun.lockb package-lock.json yarn.lock pnpm-lock.yaml Cargo.lock poetry.lock uv.lock go.sum 2>/dev/null || echo "No lockfiles found"`

## Step 1: Import from existing configs (if any)

Check for existing Codex configurations and use them as the primary source. Imported values take precedence over auto-detected values.

### Import from existing `deus.json` (or legacy format)

If `deus.json` exists with the old simple format (`scripts.setup`, `scripts.run`, `runScriptMode`):

| Old field         | New field                                                                |
| ----------------- | ------------------------------------------------------------------------ |
| `scripts.setup`   | `lifecycle.setup` (also keep in `scripts.setup` for backwards compat)    |
| `scripts.run`     | `tasks.dev.command` with `persistent: true` (also keep in `scripts.run`) |
| `scripts.archive` | `lifecycle.archive`                                                      |
| `runScriptMode`   | `tasks.dev.mode` (also keep top-level `runScriptMode`)                   |

### Import from Codex `environment.toml`

If `.codex/environments/environment.toml` exists:

| Codex field            | New field                                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `[setup].packages`     | `lifecycle.setup` (generate install commands)                                                                                 |
| `[setup].script`       | `lifecycle.setup` (append to setup)                                                                                           |
| `[[actions]].name`     | `tasks.<name>.description`                                                                                                    |
| `[[actions]].command`  | `tasks.<name>.command`                                                                                                        |
| `[[actions]].icon`     | `tasks.<name>.icon` (map: `run`->`play`, `tool`->`terminal`, `test`->`check-circle`, `build`->`hammer`, `eye`->`search-code`) |
| `[[actions]].platform` | `tasks.<name>.platform`                                                                                                       |

## Step 2: Detect project type and package manager

| File detected                    | Tech stack | Package manager |
| -------------------------------- | ---------- | --------------- |
| `bun.lock` or `bun.lockb`        | Node.js    | `bun`           |
| `package-lock.json`              | Node.js    | `npm`           |
| `yarn.lock`                      | Node.js    | `yarn`          |
| `pnpm-lock.yaml`                 | Node.js    | `pnpm`          |
| `Cargo.toml` + `Cargo.lock`      | Rust       | `cargo`         |
| `pyproject.toml` + `uv.lock`     | Python     | `uv`            |
| `pyproject.toml` + `poetry.lock` | Python     | `poetry`        |
| `pyproject.toml`                 | Python     | `pip`           |
| `go.mod` + `go.sum`              | Go         | `go`            |
| `Gemfile`                        | Ruby       | `bundler`       |
| `composer.json`                  | PHP        | `composer`      |

## Step 3: Extract and map scripts to tasks

For Node.js projects, read `package.json` scripts and map common patterns:

| Script pattern                 | Task name                   | Icon           | Notes                        |
| ------------------------------ | --------------------------- | -------------- | ---------------------------- |
| `dev`, `start`, `serve`        | `dev`                       | `play`         | Add `persistent: true`       |
| `build`, `compile`             | `build`                     | `hammer`       |                              |
| `test`, `test:*`               | `test` (or `test:<suffix>`) | `check-circle` |                              |
| `lint`, `lint:fix`             | `lint`                      | `search-code`  |                              |
| `format`, `fmt`                | `format`                    | `paintbrush`   |                              |
| `typecheck`, `tsc`             | `typecheck`                 | `search-code`  |                              |
| `deploy`, `release`, `publish` | `deploy`                    | `rocket`       |                              |
| `storybook`                    | `storybook`                 | `book-open`    | Add `persistent: true`       |
| `preview`                      | `preview`                   | `monitor`      | Add `persistent: true`       |
| `build:*` sub-tasks            | `build:<suffix>`            | `package`      | Add as dependency of `build` |

For Rust projects, detect common cargo commands:

- `cargo build` -> `build` (hammer)
- `cargo test` -> `test` (check-circle)
- `cargo run` -> `dev` (play, persistent)
- `cargo clippy` -> `lint` (search-code)
- `cargo fmt` -> `format` (paintbrush)

For Python projects, detect from pyproject.toml scripts or common patterns:

- `pytest` -> `test` (check-circle)
- `ruff check` / `flake8` -> `lint` (search-code)
- `ruff format` / `black` -> `format` (paintbrush)
- `uvicorn` / `flask run` / `gunicorn` -> `dev` (play, persistent)

## Step 4: Detect requirements

Check runtime versions from:

- `.nvmrc`, `.node-version`, `engines` in package.json -> `requires.node`
- `packageManager` field in package.json -> `requires.bun` / `requires.pnpm` etc.
- `rust-toolchain.toml`, `rust-toolchain` -> `requires.rust`
- `pyproject.toml` `[project].requires-python` -> `requires.python`
- `.python-version` -> `requires.python`
- `go.mod` go directive -> `requires.go`

## Step 5: Generate deus.json

Merge imported config + auto-detected config (imported takes precedence). Write the file using this structure:

```json
{
  "$schema": "https://deus.dev/schemas/deus.json",
  "version": 1,
  "name": "<project name from package.json/Cargo.toml/pyproject.toml>",

  "scripts": {
    "setup": "<lifecycle.setup value>",
    "run": "<main dev command>"
  },
  "runScriptMode": "nonconcurrent",

  "requires": {
    "<runtime>": ">= <version>"
  },

  "env": {},

  "lifecycle": {
    "setup": "<setup script or command>"
  },

  "tasks": {
    "<name>": "<command>"
    // OR for tasks needing more config:
    // "<name>": {
    //   "command": "<command>",
    //   "description": "<what it does>",
    //   "icon": "<lucide icon name>",
    //   "persistent": true,
    //   "depends": ["<other task>"],
    //   "mode": "nonconcurrent",
    //   "platform": ["macos", "linux"]
    // }
  }
}
```

## Icon reference (lucide-react)

Only use these icon names (they map to lucide-react components already in our dependencies):

| Icon name      | Use case                            |
| -------------- | ----------------------------------- |
| `play`         | Dev server, run, start, serve       |
| `hammer`       | Build, compile                      |
| `check-circle` | Test, validate                      |
| `search-code`  | Lint, typecheck, analyze            |
| `paintbrush`   | Format, style                       |
| `rocket`       | Deploy, release, publish            |
| `terminal`     | Generic script, shell command       |
| `package`      | Bundle, package, sub-builds         |
| `monitor`      | Preview, storybook, visual          |
| `book-open`    | Docs, storybook                     |
| `database`     | Migrations, seed, DB operations     |
| `shield`       | Security audit, vulnerability check |
| `refresh-cw`   | Clean, reset, rebuild               |
| `globe`        | Serve, expose, tunnel               |

## Rules

- Use string shorthand for simple tasks (match detected package manager): `"test": "<pm> run test"` (e.g. `bun run test`, `npm run test`, `yarn test`, `pnpm test`)
- Use object form only when task needs icon, depends, persistent, platform, or mode
- Always include backwards-compatible `scripts.setup` and `scripts.run` fields
- The `dev` task should always have `persistent: true` if it's a long-running server
- Keep `env` minimal - only include vars that are truly needed at manifest level
- If a setup script already exists (e.g., `scripts/deus-setup.sh`), reference it rather than inlining commands
- Write the file, then show the user what was generated with a brief summary
