#!/bin/bash

# OpenDevs Desktop App Development Script
# Runs Tauri in development mode (live reload)
#
# Note: Backend is managed by Tauri's Rust BackendManager with dynamic ports.
# No need to start backend manually - Tauri handles it automatically.

set -e

echo "======================================"
echo "OpenDevs Desktop App - Dev Mode"
echo "======================================"
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

# Step 1: Check for Rust
echo -e "${YELLOW}Verifying Rust installation...${NC}"
if ! command -v rustc &> /dev/null; then
    echo -e "${RED}✗ Rust is not installed${NC}"
    echo ""
    echo "ERROR: Rust is required to run Tauri."
    echo "Please install Rust from https://rustup.rs/"
    echo ""
    exit 1
fi

RUST_VERSION=$(rustc --version)
echo -e "${GREEN}✓ Rust found: $RUST_VERSION${NC}"
echo ""

echo -e "${BLUE}Starting Tauri desktop app...${NC}"
echo -e "${YELLOW}⏱  First launch may take a few minutes to compile${NC}"
echo ""
echo -e "${YELLOW}Note: Backend will start automatically with dynamic port${NC}"
echo ""

# Start Tauri dev mode (backend is managed by Rust)
npm run tauri:dev

# This line will be reached when Tauri is stopped
echo ""
echo -e "${YELLOW}Shutting down...${NC}"
