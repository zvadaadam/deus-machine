# device-use

The Simulator tab's engine: the TypeScript the backend imports
(`device-use/engine`) and two native helpers, `simbridge` (screen stream, touch,
keyboard and buttons, accessibility tree) and `siminspector.dylib` (view
inspection inside an app). See `AGENTS.md` for what each part does and who
calls it.

```bash
bun run prepare:device-use   # at the repository root: dist/engine.js + bin/ helpers (needs Xcode)
```

## License

MIT
