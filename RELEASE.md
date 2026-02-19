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
  │   ├─ Bumps version in package.json, Cargo.toml, tauri.conf.json
  │   ├─ Commits "release: v2.1.0"
  │   └─ Creates + pushes git tag v2.1.0
  │
  ├─ Job 2: build-macos (macos-latest, arm64)
  │   ├─ Checks out the tagged commit
  │   ├─ Installs Bun + Rust (aarch64-apple-darwin)
  │   ├─ Imports Apple signing certificate into temp keychain
  │   ├─ Builds sidecar (bun run build:sidecar)
  │   ├─ Runs tauri-apps/tauri-action@v0
  │   │   ├─ Builds the Tauri app
  │   │   ├─ Code-signs with Developer ID Application cert
  │   │   ├─ Notarizes with Apple (staples the ticket)
  │   │   ├─ Signs updater bundle with minisign key
  │   │   └─ Creates draft GitHub Release with:
  │   │       ├─ Command_2.1.0_aarch64.dmg        (install package)
  │   │       ├─ Command.app.tar.gz                (auto-update bundle)
  │   │       ├─ Command.app.tar.gz.sig            (minisign signature)
  │   │       └─ latest.json                       (update manifest)
  │   └─ Done
  │
  └─ You: Review draft release on GitHub → click "Publish"
```

### Auto-Update Flow

```
User's running app
  │
  ├─ Checks: GET https://github.com/zvadaadam/box-ide/releases/latest/download/latest.json
  │   └─ Response: { version, platforms.darwin-aarch64.url, signature }
  │
  ├─ Compares version against current app version
  │   └─ If newer:
  │       ├─ Downloads Command.app.tar.gz from the release
  │       ├─ Verifies minisign signature against pubkey in tauri.conf.json
  │       ├─ Extracts and replaces Command.app
  │       └─ Restarts the app
  │
  └─ If same or older: no-op
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
- [x] Entitlements.plist (JIT + unsigned-executable-memory)
- [x] Version bump script (`scripts/bump-version.sh`)
- [x] tauri.conf.json — DMG target, category, macOS 11.0 min, DMG layout
- [x] Updater plugin configured — endpoint + minisign pubkey
- [x] Updater capability added (`updater:default`)
- [x] Tauri minisign keypair generated (no password)
- [x] `TAURI_SIGNING_PRIVATE_KEY` set in GitHub Secrets

### TODO — Apple Developer Setup

- [ ] **Apple Developer account processed** (waiting for Apple approval)
- [ ] **Create Developer ID Application certificate**
  1. Go to https://developer.apple.com/account/resources/certificates
  2. Click "+" → select "Developer ID Application"
  3. Follow CSR instructions (Keychain Access → Certificate Assistant → Request)
  4. Download the `.cer` file
  5. Double-click to install in Keychain
  6. Export as `.p12` from Keychain Access (right-click → Export)
  7. Base64 encode: `base64 -i certificate.p12 | pbcopy`
- [ ] **Create app-specific password**
  1. Go to https://account.apple.com → Sign-In and Security → App-Specific Passwords
  2. Generate one named "Command Release CI"
- [ ] **Find your Team ID**
  1. Go to https://developer.apple.com/account → Membership Details
  2. Copy the 10-character Team ID

### TODO — GitHub Secrets

Set these via `gh secret set` or GitHub UI (Settings → Secrets → Actions):

```bash
# Apple certificate (base64-encoded .p12)
gh secret set APPLE_CERTIFICATE --repo zvadaadam/box-ide < <(base64 -i /path/to/certificate.p12)

# Password you set when exporting the .p12
gh secret set APPLE_CERTIFICATE_PASSWORD --repo zvadaadam/box-ide

# Exact identity string from Keychain (run: security find-identity -v -p codesigning)
gh secret set APPLE_SIGNING_IDENTITY --repo zvadaadam/box-ide

# Apple ID email used for Developer account
gh secret set APPLE_ID --repo zvadaadam/box-ide

# App-specific password from step above
gh secret set APPLE_PASSWORD --repo zvadaadam/box-ide

# 10-char Team ID
gh secret set APPLE_TEAM_ID --repo zvadaadam/box-ide
```

### TODO — First Release

- [ ] Run a dry-run build to verify CI pipeline works: `gh workflow run release.yml -f version=2.0.1 -f dry_run=true`
- [ ] Fix any CI issues (likely: sidecar build, cert import, notarization)
- [ ] Run first real release: `gh workflow run release.yml -f version=2.0.1`
- [ ] Review and publish the draft release on GitHub
- [ ] Download DMG from release, install, verify app works + is notarized: `spctl --assess -vvv /Applications/Command.app`

### TODO — Frontend Update UI (Future)

- [ ] Add "Check for Updates" button in settings
- [ ] Show update-available banner/toast when new version detected
- [ ] Download progress indicator
- [ ] "Restart to Update" button
- [ ] Automatic check on app launch (with user preference to disable)

### TODO — Future Improvements

- [ ] x86_64 / universal binary support (add to workflow matrix)
- [ ] Windows build target
- [ ] Release notes auto-generation from commit history
- [ ] Custom DMG background image

---

## Key Files

| File | Purpose |
|------|---------|
| `.github/workflows/release.yml` | One-click release workflow |
| `scripts/bump-version.sh` | Bumps version in all config files |
| `src-tauri/Entitlements.plist` | macOS hardened runtime entitlements |
| `src-tauri/tauri.conf.json` | Bundle config, updater endpoint + pubkey |
| `src-tauri/capabilities/default.json` | Tauri permissions (includes updater) |

## Key Secrets

| Secret | Where |
|--------|-------|
| `~/.tauri/command.key` | Local backup of minisign private key |
| `~/.tauri/command.key.pub` | Public key (also in tauri.conf.json) |
| `TAURI_SIGNING_PRIVATE_KEY` | GitHub Secret — minisign private key |
| `APPLE_CERTIFICATE` | GitHub Secret — base64 .p12 cert |
| `APPLE_CERTIFICATE_PASSWORD` | GitHub Secret — .p12 password |
| `APPLE_SIGNING_IDENTITY` | GitHub Secret — signing identity string |
| `APPLE_ID` | GitHub Secret — Apple ID email |
| `APPLE_PASSWORD` | GitHub Secret — app-specific password |
| `APPLE_TEAM_ID` | GitHub Secret — 10-char team ID |

## Important Notes

- **Never lose `~/.tauri/command.key`** — if you lose it, existing users can't verify updates and auto-update breaks. You'd need to regenerate and ship a full reinstall.
- **Changing Apple Developer account is safe** — Apple signing is for Gatekeeper trust (first install). Auto-updates use the Tauri minisign key, which is independent of Apple certs.
- **Releases are draft by default** — you must manually publish them on GitHub after verifying the build.
- **arm64 only for now** — matching Conductor.app's approach. Intel support can be added later as a matrix entry.
