#!/usr/bin/env bash
# Bump the root package.json version (electron-builder reads version from here).
# Sub-packages (cloud-relay, agent-dots) are internal and versioned independently.
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

# 1. package.json (root — electron-builder reads this)
jq --arg v "$VERSION" '.version = $v' "$REPO_ROOT/package.json" > "$REPO_ROOT/package.json.tmp"
mv "$REPO_ROOT/package.json.tmp" "$REPO_ROOT/package.json"
echo "  package.json -> $VERSION"

# 2. apps/cli/package.json (npm publish uses this)
CLI_PKG="$REPO_ROOT/apps/cli/package.json"
if [ -f "$CLI_PKG" ]; then
  jq --arg v "$VERSION" '.version = $v' "$CLI_PKG" > "$CLI_PKG.tmp"
  mv "$CLI_PKG.tmp" "$CLI_PKG"
  echo "  apps/cli/package.json -> $VERSION"
fi

echo "Done. All files bumped to $VERSION"
