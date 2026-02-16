# Auto-Updater — Implementation Guide

How we ship updates to desktop users. Uses the official `tauri-plugin-updater` (already installed at v2.9.0) with GitHub Releases as the distribution backend.

---

## Current State

- Plugin installed: `tauri-plugin-updater = "=2.9.0"` in `Cargo.toml`
- Config skeleton in `tauri.conf.json` (empty `endpoints` and `pubkey`)
- No signing keypair generated yet
- No CI release workflow yet

---

## Architecture

```
Build (CI):
  GitHub Action (tauri-action)
    → Builds macOS / Windows / Linux binaries
    → Signs each artifact with Ed25519 private key
    → Generates latest.json with versions, URLs, signatures
    → Uploads everything to GitHub Release

Runtime (App):
  App calls check() on startup / interval
    → GET https://github.com/<org>/<repo>/releases/latest/download/latest.json
    → Compares current_version vs latest version
    → If newer: downloads binary, verifies Ed25519 signature, installs
    → macOS: replaces .app from .tar.gz
    → Windows: runs NSIS installer (app exits during install)
    → Linux: replaces AppImage
```

---

## Setup Steps

### 1. Generate Signing Keypair

```bash
bun tauri signer generate -w ~/.tauri/command.key
```

This outputs:
- **Private key** → `~/.tauri/command.key` (keep secret, add to CI secrets)
- **Public key** → printed to stdout (embed in `tauri.conf.json`)
- **Password** → optional, set during generation

Store the private key securely. If lost, existing installs can never be updated.

### 2. Configure tauri.conf.json

```json
{
  "bundle": {
    "createUpdaterArtifacts": true
  },
  "plugins": {
    "updater": {
      "pubkey": "<paste public key here>",
      "endpoints": [
        "https://github.com/<org>/<repo>/releases/latest/download/latest.json"
      ]
    }
  }
}
```

### 3. CI Workflow (GitHub Actions)

Use `tauri-apps/tauri-action` with `includeUpdaterJson: true`. The action:
- Builds for all target platforms
- Signs artifacts using `TAURI_SIGNING_PRIVATE_KEY` secret
- Generates `latest.json` automatically
- Uploads everything to a GitHub Release

Required CI secrets:
- `TAURI_SIGNING_PRIVATE_KEY` — key content (not file path)
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — if password was set

macOS additionally needs:
- `APPLE_CERTIFICATE` — Developer ID Application certificate (.p12, base64)
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`
- `APPLE_ID` + `APPLE_PASSWORD` + `APPLE_TEAM_ID` — for notarization

### 4. Frontend Integration

```typescript
import { check } from "@tauri-apps/plugin-updater";

// Check for updates (e.g., on app startup or from settings)
const update = await check();
if (update) {
  // update.version, update.body (release notes), update.date
  // Show UI prompt to user
  await update.downloadAndInstall((progress) => {
    // progress.event: "Started" | "Progress" | "Finished"
    // progress.data.contentLength, progress.data.chunkLength
  });
  // App restarts automatically on macOS/Linux
  // App exits for NSIS install on Windows
}
```

---

## Key Decisions

### Why `tauri-plugin-updater` (not alternatives)

| Considered | Verdict |
|---|---|
| **tauri-plugin-updater + GitHub Releases** | Chosen. Zero infra, free, cross-platform, community standard. |
| **CrabNebula Cloud** | Not needed yet. Adds CDN + analytics but costs EUR 5/10K downloads. Easy to migrate later since client-side code is identical. |
| **Sparkle (macOS)** | Better native UX + delta updates, but macOS-only. Would need two update systems. Not worth the maintenance. |
| **CrabNebula OTA** | Frontend-only hot updates. Interesting for React fixes but most updates touch Rust too. Revisit later. |

### Signing: Two Separate Systems on macOS

1. **Apple code signing + notarization** — required for Gatekeeper. Uses Developer ID Application certificate.
2. **Updater Ed25519 signing** — required for update verification. Uses our own keypair.

Both are mandatory. They serve different purposes and are completely independent.

---

## Known Gotchas

- **Sidecar notarization**: We use `bundle.resources` for the Node.js sidecar (not `externalBin`). Test that notarization works with the bundled `index.bundled.cjs` + native `better-sqlite3` module. This is a known pain point.
- **Version sync**: `version` must match across `package.json`, `Cargo.toml`, and `tauri.conf.json`. CI should validate this.
- **Windows UX**: App must exit during NSIS install. Silent/passive mode has known bugs around restart. Consider warning users before update.
- **No delta updates**: Every update downloads the full binary (~20-50 MB). No binary diff support in the official plugin. Acceptable for now.
- **No automatic rollback**: If an update is broken, we'd need to push a new release. Consider adding a health check on startup that reports version + crash status.
- **Private key in CI**: `TAURI_SIGNING_PRIVATE_KEY` must be a real env var, not a `.env` file. GitHub Actions secrets work fine.
- **Endpoint URL**: Must point to the raw JSON file, not the GitHub Release page.

---

## Future Improvements

- **Update check frequency**: Check on app launch + every 4 hours. Don't interrupt active agent sessions.
- **Release channels**: Use CrabNebula Cloud or a Cloudflare Worker proxy if we need beta/nightly channels.
- **Download progress UI**: Show progress bar in a toast or modal. Use the `downloadAndInstall` progress callback.
- **Changelog display**: Parse `update.body` (GitHub Release notes) and show in the update prompt.
- **Forced updates**: For critical security fixes, server could return a `forceUpdate: true` flag (requires custom endpoint, not static JSON).
- **Analytics**: Track update adoption rates. CrabNebula Cloud provides this, or we could log to our own telemetry.
