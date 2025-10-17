#!/bin/bash

# Conductor Desktop App Build Script
# Builds the full Tauri desktop application for macOS

set -e  # Exit on any error

echo "======================================"
echo "Conductor Desktop App - Build"
echo "======================================"
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Step 1: Check for Rust
echo -e "${YELLOW}[1/4] Verifying Rust installation...${NC}"
if ! command -v rustc &> /dev/null; then
    echo -e "${RED}✗ Rust is not installed${NC}"
    echo ""
    echo "ERROR: Rust is required to build the desktop app."
    echo "Please install Rust from https://rustup.rs/"
    echo ""
    echo "Quick install:"
    echo "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    echo ""
    exit 1
fi

RUST_VERSION=$(rustc --version)
echo -e "${GREEN}✓ Rust found: $RUST_VERSION${NC}"

# Step 2: Check for Node.js
echo ""
echo -e "${YELLOW}[2/4] Verifying Node.js installation...${NC}"
if ! command -v node &> /dev/null; then
    echo -e "${RED}✗ Node.js is not installed${NC}"
    echo ""
    echo "ERROR: Node.js is required but not found."
    echo "Please install Node.js v18+ from https://nodejs.org/"
    echo ""
    exit 1
fi

NODE_VERSION=$(node --version)
echo -e "${GREEN}✓ Node.js found: $NODE_VERSION${NC}"

# Step 3: Build frontend
echo ""
echo -e "${YELLOW}[3/4] Building frontend...${NC}"
npm run build
echo -e "${GREEN}✓ Frontend built successfully${NC}"

# Step 4: Build Tauri desktop app
echo ""
echo -e "${YELLOW}[4/4] Building Tauri desktop app...${NC}"
echo "⏱  This may take 5-10 minutes on first build..."
echo ""

npm run tauri:build

# Check if build was successful
if [ -d "src-tauri/target/release/bundle/macos/Conductor.app" ]; then
    echo ""
    echo -e "${GREEN}======================================"
    echo -e "✓ Desktop app built successfully!"
    echo -e "======================================${NC}"
    echo ""
    echo "App location:"
    echo "  src-tauri/target/release/bundle/macos/Conductor.app"
    echo ""
    echo "To install:"
    echo "  cp -r src-tauri/target/release/bundle/macos/Conductor.app /Applications/"
    echo ""
    echo "To run:"
    echo "  open /Applications/Conductor.app"
    echo ""
else
    echo -e "${RED}✗ Build failed. Check errors above.${NC}"
    exit 1
fi
