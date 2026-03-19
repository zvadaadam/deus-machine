#!/bin/bash

# OpenDevs - Development Server Script
# Runs both frontend and backend in parallel with dynamic ports

set -e

echo "======================================"
echo "OpenDevs - Development Mode"
echo "======================================"
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

# Trap to kill background processes on exit
trap 'kill $(jobs -p) 2>/dev/null; rm -f /tmp/backend_port.txt /tmp/sidecar.log' EXIT

# Kill any stale Vite process on port 1420 to prevent Electron from
# connecting to an outdated dev server from a previous session.
STALE_PID=$(lsof -ti:1420 2>/dev/null || true)
if [ -n "$STALE_PID" ]; then
    echo -e "${YELLOW}Killing stale process on port 1420 (PID: $STALE_PID)...${NC}"
    kill -9 $STALE_PID 2>/dev/null || true
    sleep 0.3
fi

# Build browser inject scripts (TypeScript → IIFE for WKWebView)
echo -e "${BLUE}Building browser inject scripts...${NC}"
bun run build:inject
echo -e "${GREEN}✓ Inject scripts built${NC}"
echo ""

# Start agent-server (sidecar) first to get its LISTEN_URL
echo -e "${BLUE}Starting agent-server...${NC}"
node src-tauri/resources/bin/index.bundled.cjs > /tmp/sidecar.log 2>&1 &
SIDECAR_PID=$!

# Wait and capture the listen URL
AGENT_SERVER_URL=""
for i in {1..20}; do
    if grep -q 'LISTEN_URL=' /tmp/sidecar.log 2>/dev/null; then
        AGENT_SERVER_URL=$(grep 'LISTEN_URL=' /tmp/sidecar.log | head -1 | sed 's/.*LISTEN_URL=//')
        break
    fi
    sleep 0.3
done

if [ -n "$AGENT_SERVER_URL" ]; then
    echo -e "${GREEN}✓ Agent-server started at $AGENT_SERVER_URL (PID: $SIDECAR_PID)${NC}"
else
    echo -e "${YELLOW}⚠ Agent-server URL not detected, backend will run without agent connection${NC}"
fi
echo ""

# Start backend server with dynamic port + agent-server URL
echo -e "${BLUE}Starting backend server with dynamic port...${NC}"
AGENT_SERVER_URL=$AGENT_SERVER_URL PORT=0 node apps/backend/server.cjs > /tmp/backend.log 2>&1 &
BACKEND_PID=$!

# Wait and capture the dynamic port
echo -e "${YELLOW}Waiting for backend to assign port...${NC}"
BACKEND_PORT=""
for i in {1..30}; do
    if grep -q '\[BACKEND_PORT\]' /tmp/backend.log 2>/dev/null; then
        BACKEND_PORT=$(grep '\[BACKEND_PORT\]' /tmp/backend.log | head -1 | sed 's/.*\[BACKEND_PORT\]//')
        break
    fi
    sleep 0.5
done

# Check if we got the port
if [ -z "$BACKEND_PORT" ]; then
    echo -e "${RED}✗ Failed to capture backend port${NC}"
    cat /tmp/backend.log
    exit 1
fi

# Check if backend is running
if ps -p $BACKEND_PID > /dev/null; then
    echo -e "${GREEN}✓ Backend server started on port $BACKEND_PORT (PID: $BACKEND_PID)${NC}"
else
    echo -e "${RED}✗ Backend server failed to start${NC}"
    cat /tmp/backend.log
    exit 1
fi

echo ""
echo -e "${BLUE}Starting frontend dev server...${NC}"
echo ""

# Start frontend with backend port as environment variable
VITE_BACKEND_PORT=$BACKEND_PORT bun run dev:frontend

# This line will be reached when bun run dev:frontend is stopped
echo ""
echo -e "${YELLOW}Shutting down servers...${NC}"
