# 🚀 Running OpenDevs (BOX IDE)

This guide shows you how to run the OpenDevs application in development mode.

---

## 📋 Prerequisites

Before running the app, make sure you have:

1. **Node.js v18+** installed
2. **npm** (comes with Node.js)
3. **Dependencies installed:**
   ```bash
   npm install
   ```

---

## 🎯 Quick Start - Run Everything

### **Option 1: Use the Dev Script (Recommended)**

Run both frontend and backend together:

```bash
./dev.sh
```

Or using npm:

```bash
npm run dev:full
```

This will:
1. Start the backend server on `http://localhost:3333`
2. Start the frontend dev server on `http://localhost:5173`
3. Both will run in parallel

**To stop:** Press `Ctrl+C` once - it will stop both servers.

---

## 🔧 Run Frontend and Backend Separately

### **Option 2: Separate Terminals**

If you prefer to run them separately for easier debugging:

**Terminal 1 - Backend:**
```bash
npm run dev:backend
```

This starts the Express server on port 3333.

**Terminal 2 - Frontend:**
```bash
npm run dev
```

This starts the Vite dev server on port 5173.

---

## 🌐 Access the App

Once both servers are running:

**Frontend:** Open your browser to:
```
http://localhost:5173
```

**Backend API:** Available at:
```
http://localhost:3333/api
```

**Health Check:**
```bash
curl http://localhost:3333/api/health
```

---

## 📁 What's Running

### **Backend Server (`backend/server.cjs`)**
- **Port:** 3333
- **Purpose:**
  - API endpoints for workspaces, sessions, repos
  - Claude Code session management
  - Database operations (SQLite)
  - Sidecar process communication
  - Configuration management (MCP servers, commands, agents)

**Key Endpoints:**
- `GET /api/health` - Health check
- `GET /api/workspaces` - List workspaces
- `GET /api/repos` - List repositories
- `GET /api/sessions` - List sessions
- `GET /api/config/mcp-servers` - MCP server config
- And many more (see `backend/README.md`)

### **Frontend Dev Server (Vite)**
- **Port:** 5173
- **Purpose:**
  - React UI with hot reload
  - Tailwind CSS with JIT
  - TypeScript compilation
  - Development-only features

---

## 🛠️ Troubleshooting

### **Backend won't start**

**Issue:** Port 3333 already in use

**Solution:**
```bash
# Check what's using port 3333
lsof -i :3333

# Kill the process
kill -9 <PID>
```

---

### **Frontend can't connect to backend**

**Issue:** API calls failing with CORS errors

**Check:**
1. Backend is running: `curl http://localhost:3333/api/health`
2. CORS is enabled in `backend/server.cjs` (it should be by default)

---

### **Database errors**

**Issue:** SQLite database not found or locked

**Check:**
```bash
# Database location (from backend/lib/database.cjs)
ls -la ~/Library/Application\ Support/com.conductor.app/conductor.db
```

If database doesn't exist, it will be created automatically on first run.

---

### **Module errors**

**Issue:** `Cannot find module` errors

**Solution:**
```bash
# Reinstall dependencies
rm -rf node_modules package-lock.json
npm install
```

---

## 📦 Production Build

To build for production:

```bash
# Build frontend
npm run build

# This creates dist/ directory with optimized assets
```

The built files will be in `dist/` directory.

To preview the production build:
```bash
npm run preview
```

---

## 🖥️ Building the Desktop App (Tauri)

To build the full Tauri desktop application:

```bash
# Development mode (with hot reload)
npm run tauri:dev

# Production build
npm run tauri:build
```

This will create a macOS app bundle at:
```
src-tauri/target/release/bundle/macos/OpenDevs.app
```

See `setup-and-build.sh` for the full build process.

---

## 📂 Project Structure

```
box-ide/
├── backend/              # Express backend server
│   ├── server.cjs       # Main server entry point
│   ├── lib/             # Core modules (database, claude-session, etc.)
│   └── routes/          # API route handlers
├── src/                  # React frontend
│   ├── components/      # UI components
│   ├── features/        # Feature modules
│   └── stores/          # Zustand state stores
├── src-tauri/           # Tauri desktop app (Rust)
├── dev.sh               # Development script (runs both servers)
└── package.json         # Dependencies and scripts
```

---

## 🎨 Development Features

### **Hot Reload**
- Frontend: Changes to React components reload instantly
- Tailwind CSS: JIT compilation for instant styling
- Backend: Restart backend manually for changes

### **TypeScript**
- Full TypeScript support
- Type checking in VS Code
- Build-time type errors

### **Tailwind CSS**
- JIT mode for fast compilation
- shadcn/ui components
- Custom design tokens
- CLAUDE.md animation guidelines

---

## 🔑 Key Commands Summary

| Command | Description |
|---------|-------------|
| `./dev.sh` or `npm run dev:full` | Run both frontend + backend |
| `npm run dev` | Run frontend only (port 5173) |
| `npm run dev:backend` | Run backend only (port 3333) |
| `npm run build` | Build frontend for production |
| `npm run preview` | Preview production build |
| `npm run tauri:dev` | Run Tauri desktop app |
| `npm run tauri:build` | Build Tauri desktop app |

---

## 💡 Tips

1. **Use separate terminals** for frontend and backend if you need to see logs from both clearly.

2. **Backend logs** show API requests, Claude Code sessions, and database operations.

3. **Frontend logs** show in browser console (press F12).

4. **Database viewer:** Use a SQLite browser to view the database:
   ```bash
   open ~/Library/Application\ Support/com.conductor.app/conductor.db
   ```

5. **Hot reload** works for frontend, but backend changes require restart.

---

## 🚢 Ready to Ship?

Once your migration is tested and working:

1. ✅ Build frontend: `npm run build`
2. ✅ Test backend: `npm run dev:backend`
3. ✅ Build Tauri app: `npm run tauri:build`
4. ✅ Ship it! 🚀

---

## 📖 Additional Documentation

- **Backend API:** See `backend/README.md` for full API documentation
- **Architecture:** See `ARCHITECTURE.md` for system design
- **Tailwind Migration:** See `MIGRATION-JOURNEY.md` for migration details

---

**Need Help?**

Check the logs in your terminal for error messages. Most issues are:
- Port conflicts (use different ports or kill existing processes)
- Missing dependencies (run `npm install`)
- Database permissions (check file permissions)

---

Last Updated: 2025-10-17
Status: Ready to run! 🚀
