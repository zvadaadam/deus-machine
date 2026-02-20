#!/usr/bin/env bash
# Bump version across all config files (package.json, Cargo.toml, tauri.conf.json)
# Usage: bash scripts/bump-version.sh 2.1.0

set -euo pipefail

VERSION="${1:?Usage: bump-version.sh <version>}"

# Validate semver format
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$ ]]; then
  echo "Error: '$VERSION' is not valid semver (expected X.Y.Z or X.Y.Z-pre.N)"
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "Bumping version to $VERSION..."

# 1. package.json
jq --arg v "$VERSION" '.version = $v' "$REPO_ROOT/package.json" > "$REPO_ROOT/package.json.tmp"
mv "$REPO_ROOT/package.json.tmp" "$REPO_ROOT/package.json"
echo "  package.json -> $VERSION"

# 2. src-tauri/tauri.conf.json
jq --arg v "$VERSION" '.version = $v' "$REPO_ROOT/src-tauri/tauri.conf.json" > "$REPO_ROOT/src-tauri/tauri.conf.json.tmp"
mv "$REPO_ROOT/src-tauri/tauri.conf.json.tmp" "$REPO_ROOT/src-tauri/tauri.conf.json"
echo "  tauri.conf.json -> $VERSION"

# 3. src-tauri/Cargo.toml (update first version = "X.Y.Z" in [package] section)
# Use perl for cross-platform compat (sed -i differs between macOS and Linux)
perl -i -pe "s/^version = \"[^\"]*\"/version = \"$VERSION\"/" "$REPO_ROOT/src-tauri/Cargo.toml"
echo "  Cargo.toml -> $VERSION"

echo "Done. All files bumped to $VERSION"
