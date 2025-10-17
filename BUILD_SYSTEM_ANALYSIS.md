# Build System Analysis & Improvement Plan

**Date:** 2025-10-17
**Status:** Analysis Complete, Ready for Implementation

---

## Current Build System Overview

### Package.json Scripts
```json
{
  "dev": "vite",                    // Frontend only
  "dev:backend": "node backend/server.cjs",
  "dev:full": "./dev.sh",           // ✅ Frontend + Backend (dynamic ports)
  "build": "tsc && vite build",
  "preview": "vite preview",
  "tauri": "tauri",
  "tauri:dev": "tauri dev",         // Full Tauri app
  "tauri:build": "tauri build"      // Production build
}
```

### Shell Scripts
1. **`dev.sh`** - Web dev mode (frontend + backend with dynamic ports) ✅
2. **`conductor-dev-desktop.sh`** - Tauri dev mode ⚠️
3. **`conductor-build-desktop.sh`** - Production build
4. **`conductor-setup.sh`** - Workspace setup
5. **`setup-and-build.sh`** - Complete setup + build
6. **`test-end-to-end.sh`** - E2E tests ⚠️

### Build Flows

#### Web Development
```
npm run dev:full (./dev.sh)
  → Backend: PORT=0 node backend/server.cjs (dynamic)
  → Frontend: VITE_BACKEND_PORT=<captured> npm run dev
  → Result: Both running with dynamic ports ✅
```

#### Tauri Development
```
npm run tauri:dev
  → tauri.conf.json: beforeDevCommand = "npm run dev"
  → Frontend: Vite on port 1420
  → Backend: Rust BackendManager starts it (dynamic port)
  → Sidecar: Started by backend
```

#### Production Build
```
npm run tauri:build
  → tauri.conf.json: beforeBuildCommand = "npm run build"
  → Frontend: Build to dist/
  → Rust: Compile + bundle
  → Bundle: Includes backend/**/*.cjs + sidecar
```

---

## Issues Identified

### 🔴 Critical Issues

1. **`conductor-dev-desktop.sh` has hardcoded port 3333**
   - Lines 39-41: Starts backend manually on port 3333
   - Problem: Conflicts with dynamic port architecture
   - Impact: Can't run multiple instances, port conflicts

2. **`test-end-to-end.sh` hardcodes port 3333**
   - All API tests use `localhost:3333`
   - Won't work with dynamic ports
   - Needs to detect port from backend logs

### ⚠️ Major Issues

3. **Unused dependencies: `socket.io` + `socket.io-client`**
   - Not imported anywhere in codebase
   - App uses Unix Domain Sockets via Tauri, not Socket.IO
   - ~2MB of unnecessary dependencies

4. **Outdated documentation in scripts**
   - `conductor-setup.sh` line 84: "Backend will be at http://localhost:3333"
   - `setup-and-build.sh` line 82: "Don't forget to start the backend server"
   - Both incorrect with current architecture

### 📝 Minor Issues

5. **`conductor-dev-desktop.sh` redundantly starts backend**
   - Manually starts backend in script
   - Tauri's Rust BackendManager already handles this
   - Creates confusion about who manages backend

6. **Script naming inconsistency**
   - Mix of `conductor-*-desktop.sh` and plain `dev.sh`
   - `setup-and-build.sh` vs `conductor-build-desktop.sh` do similar things

---

## Improvement Plan

### Phase 1: Remove Unused Dependencies ✅ Safe

**Remove:**
```json
"socket.io": "^4.8.1",
"socket.io-client": "^4.8.1"
```

**Verification:**
```bash
# Confirm no imports
grep -r "socket.io" src/ backend/ --exclude-dir=node_modules
# Should return nothing
```

**Impact:** Reduces bundle size by ~2MB, cleaner dependencies

---

### Phase 2: Fix `conductor-dev-desktop.sh` ⚠️ Breaking Change

**Current behavior:**
```bash
# Manually starts backend on port 3333
(cd backend && node server.cjs) &
BACKEND_PID=$!
```

**New behavior:**
```bash
# Let Tauri's Rust BackendManager handle it
# Remove manual backend start
# Backend will use dynamic port
```

**Rationale:**
- Tauri's `src-tauri/src/backend.rs` already manages backend lifecycle
- Backend gets dynamic port automatically
- Eliminates redundancy and port conflicts

**Changes needed:**
1. Remove lines 38-52 (backend start logic)
2. Update documentation to mention dynamic ports
3. Remove port 3333 references

---

### Phase 3: Fix `test-end-to-end.sh` 🧪 Critical

**Problem:** All tests hardcode `http://localhost:3333`

**Solution:** Auto-detect backend port

**Implementation:**
```bash
# Option 1: Read from backend logs
BACKEND_PORT=$(grep '\[BACKEND_PORT\]' /tmp/backend.log | head -1 | sed 's/.*\[BACKEND_PORT\]//')

# Option 2: Check process environment
BACKEND_PORT=$(ps aux | grep "backend/server.cjs" | grep -o "PORT=[0-9]*" | cut -d= -f2)

# Option 3: Pass as argument
./test-end-to-end.sh <port>
```

**Recommendation:** Option 3 (explicit argument) is clearest

---

### Phase 4: Update Documentation 📚

**Files to update:**

1. **`conductor-setup.sh` line 82-84**
   ```bash
   # OLD
   echo "  2. Frontend will be at http://localhost:1420"
   echo "  3. Backend will be at http://localhost:3333"

   # NEW
   echo "  2. Frontend will be at http://localhost:1420"
   echo "  3. Backend will use dynamic port (check logs)"
   ```

2. **`setup-and-build.sh` line 82-83**
   ```bash
   # OLD
   echo "Don't forget to start the backend server:"
   echo "  cd backend && node server.cjs"

   # REMOVE (backend starts automatically in Tauri app)
   ```

3. **`conductor-build-desktop.sh` line 76**
   - Add note about backend being bundled and auto-starting

---

## Verification Plan

### Test 1: Web Dev Mode
```bash
./dev.sh
# Verify: Backend gets dynamic port
# Verify: Frontend detects it
# Verify: No port 3333 references
```

### Test 2: Tauri Dev Mode
```bash
npm run tauri:dev
# Verify: Backend starts automatically
# Verify: Dynamic port assigned
# Verify: Sidecar connects
```

### Test 3: Production Build
```bash
npm run tauri:build
# Verify: App builds successfully
# Verify: Backend bundled correctly
# Verify: App runs and backend auto-starts
```

### Test 4: E2E Tests
```bash
npm run dev:full &
sleep 5
./test-end-to-end.sh <captured-port>
# Verify: All tests pass
```

---

## Dependencies Audit

### ✅ Keep (All Used)

**Frontend Framework:**
- `react`, `react-dom` - Core framework
- `react-router-dom` - Routing
- `zustand` - State management

**UI Components:**
- `@radix-ui/*` - Headless UI components (Shadcn base)
- `lucide-react` - Icons
- `class-variance-authority`, `clsx`, `tailwind-merge` - Styling utilities

**Code Editor:**
- `@codemirror/*` - Code editor (used for diffs)

**Terminal:**
- `xterm`, `xterm-addon-fit`, `xterm-addon-web-links` - Terminal emulator

**Tauri:**
- `@tauri-apps/api`, `@tauri-apps/plugin-*` - Tauri integration

**Backend:**
- `express` - HTTP server
- `cors` - CORS middleware
- `better-sqlite3` - Database

**Build Tools:**
- `vite`, `@vitejs/plugin-react` - Build system
- `typescript`, `@types/*` - Type checking
- `tailwindcss`, `autoprefixer`, `postcss` - Styling

**Claude Integration:**
- `@anthropic-ai/claude-code` - Claude CLI integration

### ❌ Remove (Unused)

**Socket.IO:**
- `socket.io` - Server-side Socket.IO (NOT USED)
- `socket.io-client` - Client-side Socket.IO (NOT USED)

**Why unused?**
- App uses Unix Domain Sockets via Tauri's Rust layer
- See `src/services/socket.ts` - uses `invoke()`, not Socket.IO
- Backend sidecar uses `net` module (Node.js native), not Socket.IO

---

## Implementation Order

### ✅ Safe Changes (Do First)
1. Remove `socket.io` dependencies
2. Update documentation in scripts
3. Add comments explaining dynamic ports

### ⚠️ Breaking Changes (Test Thoroughly)
4. Update `conductor-dev-desktop.sh`
5. Update `test-end-to-end.sh`
6. Test all build modes

### 🚀 Optional Enhancements (Later)
7. Rename scripts for consistency
8. Add production build test script
9. Add CI/CD workflow

---

## Summary

**Total Issues:** 6
**Critical:** 2 (ports)
**Major:** 2 (deps, docs)
**Minor:** 2 (redundancy, naming)

**Estimated Time:** 30-45 minutes
**Risk Level:** Low (mostly docs and cleanup)
**Breaking Changes:** 2 (conductor-dev-desktop.sh, test script)

**Recommendation:** Proceed with Phase 1-3, defer Phase 4 enhancements.
