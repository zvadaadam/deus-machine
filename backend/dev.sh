#!/bin/bash

# OpenDevs Dev Script (Backend Directory)
# Runs both frontend and backend with dynamic port allocation
#
# Note: For the main workspace dev script, use ../dev.sh instead
# This script is here for legacy/convenience but ../dev.sh is the canonical version

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
trap 'kill $(jobs -p) 2>/dev/null; rm -f /tmp/backend.log' EXIT

# Start backend server with dynamic port
echo -e "${BLUE}Starting backend server with dynamic port...${NC}"
cd .. && PORT=0 node backend/server.cjs > /tmp/backend.log 2>&1 &
BACKEND_PID=$!
cd backend

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
cd .. && VITE_BACKEND_PORT=$BACKEND_PORT npm run dev
