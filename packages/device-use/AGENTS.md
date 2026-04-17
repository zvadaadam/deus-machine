# AGENTS.md

Notes for Claude / agents working on this codebase.

## Layout

- `native/` — Swift package producing the `simbridge` binary. Uses private
  CoreSimulator/AccessibilityPlatform frameworks. **Don't rewrite** without
  very good reason; it's ~3k LOC of Swift doing work that can't be done
  from JS.
- `src/engine/` — Pure primitives. No CLI/SDK imports. Tests here should be
  fast and have no external dependencies.
- `src/cli/` — Hand-rolled arg parser + command registry. Each command
  lives in `src/cli/commands/<name>.ts` with a zod schema and a handler.
- `src/sdk/` — Fluent `session()` builder. Used for programmatic automation.
- `skills/device-use/SKILL.md` — Gets copied to `~/.claude/skills/` by
  `device-use install`.

## Adding a command

1. Create `src/cli/commands/foo.ts` exporting `fooCommand: CommandDefinition<Params>`.
2. Register it in `src/cli/index.ts`.
3. Add examples to the help text + to `skills/device-use/SKILL.md`.

## Build pipeline

- `bun run build:native` → Swift binary at `native/.build/release/simbridge`
- `bun run build:ts` → ESM bundles in `dist/` (CLI, SDK, engine)
- `bun run compile` → Single compiled executable at `bin/device-use`,
  with `simbridge` copied to `bin/simbridge`

## simbridge path resolution

The CLI finds `simbridge` in this order:

1. `$DEVICE_USE_SIMBRIDGE` env override
2. Sibling of `process.execPath` (compiled-binary case)
3. Relative to `import.meta.url` (dev / bundled case)

If you change packaging, make sure `findBridgePath()` in
`src/engine/simbridge.ts` still locates the binary.

## JSON contract

All commands return:

```json
{ "success": true, "command": "...", "data": ..., "message": "...", "nextSteps": [], "warnings": [] }
```

Commands auto-switch to JSON when stdout is not a TTY. Agents should pipe
stderr to `/dev/null` — `simbridge` prints diagnostics there.

## Testing against the real simulator

Boot any iOS simulator and run `./bin/device-use doctor` to confirm
everything is wired up. Then:

```
./bin/device-use snapshot -i 2>/dev/null | jq .
./bin/device-use tap @e1
```
