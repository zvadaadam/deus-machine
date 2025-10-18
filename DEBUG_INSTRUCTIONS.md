# 🔍 Debug Instructions - "Load failed" Error

## The Problem
You're seeing "Load failed" but we need to see the **actual detailed error** to fix it.

## Step 1: Open Browser DevTools in Tauri App

The Tauri app window is actually a web browser. We need to open its console:

### On Mac:
1. **Focus the Tauri app window** (the Conductor app)
2. Press **Cmd + Option + I** (Command + Option + I)
   - Or right-click anywhere in the app → **Inspect**
3. Click the **Console** tab at the top

### On Windows/Linux:
1. Focus the Tauri app window
2. Press **Ctrl + Shift + I**
3. Click the **Console** tab

## Step 2: Watch the Console While Testing

With DevTools open and Console tab visible:

1. **Select a workspace** (or create one)
2. **Go to Browser panel** (right side)
3. **Watch the Console** - you should see logs like:
   ```
   [useDevBrowser] Calling start_browser_server with path: /Users/zvada/Documents/BOX/dev-browser
   [useDevBrowser] Error starting server: ...
   [useDevBrowser] Error type: object
   [useDevBrowser] Error details: { ... }
   ```

## Step 3: Copy the Full Error Output

**In the DevTools Console**, look for:
- Any lines starting with `[useDevBrowser]`
- Any red error messages
- Expand any collapsed objects (triangles ▶) to see full details

**Copy ALL of this output and send it to me.**

## Step 4: Check Terminal Output

In the terminal where you ran `npm run tauri:dev`, look for:
- Lines starting with `[COMMAND]`
- Lines starting with `[BROWSER]`
- Any error messages around the "Load failed" lines

**Copy this output too.**

## What We're Looking For

The console logs I added will show us:
1. ✅ The exact path being passed to Rust
2. ✅ The actual error message (not just "Load failed")
3. ✅ Whether the Rust code is even being called
4. ✅ What type of error it is

## Quick Test

Once DevTools is open, try this:
1. In the Console tab, type: `console.log('Test from console')`
2. Press Enter
3. You should see "Test from console" appear

This confirms DevTools is working and showing logs.

---

**Send me both outputs (browser console + terminal) and I can diagnose the exact issue!**
