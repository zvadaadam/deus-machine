#!/bin/bash

# OpenDevs Workspace Setup Script
# Sets up a new workspace with dependencies and configuration

set -e  # Exit on any error

echo "======================================"
echo "OpenDevs Workspace Setup"
echo "======================================"
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Validate OpenDevs environment variable
if [ -z "$CONDUCTOR_ROOT_PATH" ]; then
    echo -e "${RED}ERROR: CONDUCTOR_ROOT_PATH environment variable not set${NC}"
    echo ""
    echo "This script must be run by OpenDevs, which sets this variable automatically."
    echo ""
    exit 1
fi

# Step 1: Check for Node.js
echo -e "${YELLOW}[1/3] Verifying Node.js installation...${NC}"
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

# Check for npm
if ! command -v npm &> /dev/null; then
    echo -e "${RED}✗ npm is not installed${NC}"
    echo ""
    echo "ERROR: npm is required but not found."
    echo "Please install npm (usually comes with Node.js)"
    echo ""
    exit 1
fi

NPM_VERSION=$(npm --version)
echo -e "${GREEN}✓ npm found: v$NPM_VERSION${NC}"

# Step 2: Copy .env and .mcp.json files from root repo if they exist
echo ""
echo -e "${YELLOW}[2/3] Checking for .env and .mcp.json files...${NC}"

# Copy .env file
if [ -f "$CONDUCTOR_ROOT_PATH/.env" ]; then
    cp "$CONDUCTOR_ROOT_PATH/.env" .env
    echo -e "${GREEN}✓ Copied .env from root repository${NC}"
elif [ -f "$CONDUCTOR_ROOT_PATH/.env.example" ]; then
    cp "$CONDUCTOR_ROOT_PATH/.env.example" .env
    echo -e "${YELLOW}⚠ Copied .env.example - you may need to configure it${NC}"
else
    echo -e "${YELLOW}⚠ No .env file found in root repository${NC}"
    echo "  If you need environment variables, create .env manually"
fi

# Copy .mcp.json file
if [ -f "$CONDUCTOR_ROOT_PATH/.mcp.json" ]; then
    cp "$CONDUCTOR_ROOT_PATH/.mcp.json" .mcp.json
    echo -e "${GREEN}✓ Copied .mcp.json from root repository${NC}"
elif [ -f "$CONDUCTOR_ROOT_PATH/.mcp.json.example" ]; then
    cp "$CONDUCTOR_ROOT_PATH/.mcp.json.example" .mcp.json
    echo -e "${YELLOW}⚠ Copied .mcp.json.example - you may need to configure MCP server paths${NC}"
elif [ -f ".mcp.json.example" ]; then
    cp ".mcp.json.example" .mcp.json
    echo -e "${YELLOW}⚠ Created .mcp.json from template - you may need to configure MCP server paths${NC}"
else
    echo -e "${YELLOW}⚠ No .mcp.json file found${NC}"
    echo "  MCP features will use default configuration"
fi

# Step 3: Install dependencies
echo ""
echo -e "${YELLOW}[3/3] Installing npm dependencies...${NC}"
npm install
echo -e "${GREEN}✓ Dependencies installed successfully${NC}"

# Success!
echo ""
echo -e "${GREEN}======================================"
echo -e "✓ Workspace setup complete!"
echo -e "======================================${NC}"
echo ""
echo "Next steps:"
echo "  1. Run './dev.sh' to start web dev servers"
echo "  2. Frontend will be at http://localhost:1420"
echo "  3. Backend will use dynamic port (check terminal output)"
echo ""
echo "Or run 'npm run tauri:dev' for Tauri desktop app"
echo ""
