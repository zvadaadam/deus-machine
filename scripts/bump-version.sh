#!/usr/bin/env bash
# Bump the root package.json version (electron-builder reads version from here).
# Sub-packages (cloud-relay, agent-dots, mcp-notebook) are internal and versioned independently.
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

echo "Done. All files bumped to $VERSION"
