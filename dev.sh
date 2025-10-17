#!/bin/bash

# Conductor - Development Server Script
# Runs both frontend and backend in parallel

set -e

echo "======================================"
echo "Conductor - Development Mode"
echo "======================================"
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Trap to kill background processes on exit
trap 'kill $(jobs -p) 2>/dev/null' EXIT

# Start backend server in background
echo -e "${BLUE}Starting backend server on port 3333...${NC}"
(cd backend && node server.cjs) &
BACKEND_PID=$!

# Wait a moment for backend to start
sleep 2

# Check if backend is running
if ps -p $BACKEND_PID > /dev/null; then
    echo -e "${GREEN}✓ Backend server started (PID: $BACKEND_PID)${NC}"
else
    echo -e "${RED}✗ Backend server failed to start${NC}"
    exit 1
fi

echo ""
echo -e "${BLUE}Starting frontend dev server...${NC}"
echo ""

# Start frontend (this will block)
npm run dev

# This line will be reached when npm run dev is stopped
echo ""
echo -e "${YELLOW}Shutting down servers...${NC}"
