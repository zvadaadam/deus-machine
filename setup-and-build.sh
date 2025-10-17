#!/bin/bash

# OpenDevs - Setup and Build Script
# This script installs dependencies and builds the macOS app

set -e  # Exit on any error

echo "======================================"
echo "OpenDevs - Setup and Build"
echo "======================================"
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check if Rust is installed
echo -e "${YELLOW}[1/5] Checking Rust installation...${NC}"
if command -v rustc &> /dev/null; then
    RUST_VERSION=$(rustc --version)
    echo -e "${GREEN}✓ Rust is installed: $RUST_VERSION${NC}"
else
    echo -e "${RED}✗ Rust is not installed${NC}"
    echo ""
    echo "Installing Rust..."
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

    # Source cargo environment
    source "$HOME/.cargo/env"

    echo -e "${GREEN}✓ Rust installed successfully${NC}"
fi

# Check if Node.js is installed
echo ""
echo -e "${YELLOW}[2/5] Checking Node.js installation...${NC}"
if command -v node &> /dev/null; then
    NODE_VERSION=$(node --version)
    echo -e "${GREEN}✓ Node.js is installed: $NODE_VERSION${NC}"
else
    echo -e "${RED}✗ Node.js is not installed${NC}"
    echo "Please install Node.js v18+ from https://nodejs.org/"
    exit 1
fi

# Install npm dependencies
echo ""
echo -e "${YELLOW}[3/5] Installing npm dependencies...${NC}"
npm install
echo -e "${GREEN}✓ Dependencies installed${NC}"

# Build frontend
echo ""
echo -e "${YELLOW}[4/5] Building frontend...${NC}"
npm run build
echo -e "${GREEN}✓ Frontend built successfully${NC}"

# Build Tauri app
echo ""
echo -e "${YELLOW}[5/5] Building Tauri macOS app...${NC}"
echo "This may take 5-10 minutes on first build..."
npm run tauri:build

# Check if build was successful
if [ -d "src-tauri/target/release/bundle/macos/OpenDevs.app" ]; then
    echo ""
    echo -e "${GREEN}======================================"
    echo -e "✓ Build completed successfully!"
    echo -e "======================================${NC}"
    echo ""
    echo "The app is located at:"
    echo "  src-tauri/target/release/bundle/macos/OpenDevs.app"
    echo ""
    echo "To install:"
    echo "  cp -r src-tauri/target/release/bundle/macos/OpenDevs.app /Applications/"
    echo ""
    echo "To run:"
    echo "  open /Applications/OpenDevs.app"
    echo ""
    echo "Don't forget to start the backend server:"
    echo "  cd backend && node server.cjs"
    echo ""
else
    echo -e "${RED}✗ Build failed. Check errors above.${NC}"
    exit 1
fi
