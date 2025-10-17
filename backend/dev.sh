#!/bin/bash

# Conductor Dev Script
# Runs both frontend and backend in parallel

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 Starting Conductor Development Environment${NC}"
echo ""

# Start backend in background
echo -e "${GREEN}📡 Starting backend...${NC}"
npm run dev:backend &
BACKEND_PID=$!

# Wait for backend to start
sleep 2

# Start frontend
echo -e "${GREEN}🎨 Starting frontend...${NC}"
npm run dev &
FRONTEND_PID=$!

# Trap Ctrl+C and cleanup
cleanup() {
  echo ""
  echo -e "${BLUE}👋 Shutting down...${NC}"
  kill $BACKEND_PID 2>/dev/null
  kill $FRONTEND_PID 2>/dev/null
  exit 0
}

trap cleanup SIGINT SIGTERM

# Wait for both processes
wait
