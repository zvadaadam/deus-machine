# Release & Distribution Guide

## How It Works

### Release Flow

```
You (GitHub UI or CLI)
  │
  ├─ Trigger: "Run workflow" → enter version (e.g. 2.1.0)
  │
  ├─ Job 1: validate-and-bump (ubuntu)
  │   ├─ Validates semver format
  │   ├─ Ensures release runs from main branch
  │   ├─ Checks tag doesn't already exist
  │   ├─ Bumps version in package.json
  │   ├─ Commits "release: v2.1.0"
  │   └─ Creates + pushes git tag v2.1.0
  │
  ├─ Job 2: build-macos (macos-latest, arm64)
  │   ├─ Checks out the tagged commit
  │   ├─ Installs Bun + Node.js
  │   ├─ Builds all (inject, agent-server, backend, electron-vite)
  │   ├─ Runs electron-builder --mac
  │   │   ├─ Builds the Electron app
  │   │   ├─ Code-signs with Developer ID Application cert
  │   │   ├─ Notarizes with Apple (staples the ticket)
  │   │   └─ Creates draft GitHub Release with:
  │   │       ├─ Deus-2.1.0-arm64.dmg     (install package)
  │   │       └─ Deus-2.1.0-arm64-mac.zip (portable)
  │   └─ Done
  │
  └─ You: Review draft release on GitHub → click "Publish"
```

### Triggering a Release

**From GitHub UI:**

1. Go to Actions tab → "Release" workflow → "Run workflow"
2. Enter version (e.g. `2.1.0`)
3. Optionally check "Dry run" for build-only (no GitHub Release)
4. Click "Run workflow"

**From CLI:**

```bash
gh workflow run release.yml -f version=2.1.0
```

**Dry run (build only, no release):**

```bash
gh workflow run release.yml -f version=2.1.0 -f dry_run=true
```

---

## Setup Checklist

### Done

- [x] GitHub Actions release workflow (`.github/workflows/release.yml`)
- [x] Version bump script (`scripts/bump-version.sh`)
- [x] electron-builder.yml configuration
- [x] Auto-updater setup (electron-updater)

### TODO — Apple Developer Setup

- [ ] **Apple Developer account processed** (waiting for Apple approval)
- [ ] **Create Developer ID Application certificate**
- [ ] **Create app-specific password**
- [ ] **Find your Team ID**

### TODO — GitHub Secrets

```bash
# Apple certificate (base64-encoded .p12)
gh secret set APPLE_CERTIFICATE --repo zvadaadam/box-ide < <(base64 -i /path/to/certificate.p12)

# Password you set when exporting the .p12
gh secret set APPLE_CERTIFICATE_PASSWORD --repo zvadaadam/box-ide

# Apple ID email used for Developer account
gh secret set APPLE_ID --repo zvadaadam/box-ide

# App-specific password from step above
gh secret set APPLE_PASSWORD --repo zvadaadam/box-ide

# 10-char Team ID
gh secret set APPLE_TEAM_ID --repo zvadaadam/box-ide
```

---

## Key Files

| File                                | Purpose                                  |
| ----------------------------------- | ---------------------------------------- |
| `.github/workflows/release.yml`     | One-click release workflow               |
| `scripts/bump-version.sh`           | Bumps version in all config files        |
| `electron-builder.yml`              | Electron Builder packaging configuration |
| `apps/desktop/main/auto-updater.ts` | Auto-update via electron-updater         |

## Important Notes

- **Releases are draft by default** — you must manually publish them on GitHub after verifying the build.
- **arm64 only for now** — Intel support can be added later as a matrix entry.
