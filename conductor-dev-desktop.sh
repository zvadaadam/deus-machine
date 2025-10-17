#!/bin/bash

# Conductor Desktop App Development Script
# Runs Tauri in development mode (live reload)

set -e

echo "======================================"
echo "Conductor Desktop App - Dev Mode"
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

# Trap to kill background processes on exit
trap 'kill $(jobs -p) 2>/dev/null' EXIT

# Step 2: Start backend server in background
echo -e "${BLUE}Starting backend server on port 3333...${NC}"
(cd backend && node server.cjs) &
BACKEND_PID=$!

# Wait for backend to start
sleep 2

# Check if backend is running
if ps -p $BACKEND_PID > /dev/null; then
    echo -e "${GREEN}✓ Backend server started (PID: $BACKEND_PID)${NC}"
else
    echo -e "${RED}✗ Backend server failed to start${NC}"
    exit 1
fi

echo ""
echo -e "${BLUE}Starting Tauri desktop app...${NC}"
echo -e "${YELLOW}⏱  First launch may take a few minutes to compile${NC}"
echo ""

# Step 3: Start Tauri dev mode (this will block)
npm run tauri:dev

# This line will be reached when Tauri is stopped
echo ""
echo -e "${YELLOW}Shutting down servers...${NC}"
