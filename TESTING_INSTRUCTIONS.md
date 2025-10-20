# Testing the Chat Refactor

## 🎯 What We Built

Successfully refactored chat to use an **extensible registry pattern** with:
- ✅ Modular block renderers
- ✅ Tool-specific UI components
- ✅ Centralized theme system
- ✅ Type-safe implementation

---

## 🚀 How to Test

### 1. Start the App

**Both services are already running:**
- **Backend**: http://localhost:50228 (port may vary)
- **Frontend**: http://localhost:1420

If not running:
```bash
npm run dev:full
```

### 2. Open in Browser

Navigate to: **http://localhost:1420**

### 3. Select Workspace

Click on the **"palenque"** workspace in the sidebar.

- Branch: `zvadaadam/chat-redesign`
- Status: working
- Messages: 338

### 4. Test the Chat

**What to Look For:**

#### ✅ General
- [ ] Messages render correctly
- [ ] User messages align right (blue background)
- [ ] Assistant messages align left (gray background)
- [ ] Timestamps display properly
- [ ] No console errors

#### ✅ Edit Tool Renderer
- [ ] Shows file path with 📁 icon
- [ ] Displays side-by-side diff view
  - "− Before" on left (red tint)
  - "+ After" on right (green tint)
- [ ] Copy buttons work for both before/after
- [ ] Shows success ✓ or error ✗ indicator
- [ ] Expandable/collapsible (click header)

#### ✅ Default Tool Renderer
- [ ] Other tools (Bash, Read, Grep) render with default renderer
- [ ] Shows tool name with 🔧 icon
- [ ] Displays JSON input formatted
- [ ] Expandable/collapsible
- [ ] Success/error states visible

#### ✅ Tool Results
- [ ] Success results show ✅ with green border
- [ ] Error results show ❌ with red border
- [ ] Content is readable and formatted

---

## 🐛 Known Issues to Check

### Potential Issues
1. **Tool Registry Not Loaded**
   - Check console for: `[ToolRegistry] Initialization complete`
   - Should see: `{totalRenderers: 1, tools: Array(1)}`

2. **Type Errors**
   - Check browser console for TypeScript errors
   - Should be none

3. **Styling Issues**
   - Diff view not aligned
   - Colors not from theme
   - Buttons not working

---

## 📊 Test Data Available

### Current Session Stats
- **Workspace ID**: `693e94f7-b3cf-42be-bb1a-48c1ad62e2f8`
- **Session ID**: `45de6049-cae2-4366-a3cb-b5b9ebd73631`
- **Message Count**: 338
- **Contains**: tool_use, tool_result, text blocks
- **Tools Used**: Edit, Bash, Read, Grep, Write, Glob

### API Endpoints (for debugging)
```bash
# Get workspace
curl http://localhost:50228/api/workspaces/693e94f7-b3cf-42be-bb1a-48c1ad62e2f8

# Get session
curl http://localhost:50228/api/sessions/45de6049-cae2-4366-a3cb-b5b9ebd73631

# Get messages
curl http://localhost:50228/api/sessions/45de6049-cae2-4366-a3cb-b5b9ebd73631/messages
```

---

## 🔍 Browser Console Checks

### Expected Console Output
```
✅ [ToolRegistry] Initialized tool renderer registry
✅ [ToolRegistry] Set default renderer
✅ [ToolRegistry] Registered renderer for: Edit
✅ [ToolRegistry] Initialization complete: {totalRenderers: 1, tools: Array(1), hasDefault: true}
```

### Debug Commands (in browser console)
```javascript
// Check registry status
window.__toolRegistry.getStats()

// List registered tools
window.__toolRegistry.getRegisteredTools()

// Check if Edit tool is registered
window.__toolRegistry.hasRenderer('Edit')
```

---

## ✅ Success Criteria

### Phase 1 is successful if:
- [x] App loads without errors
- [ ] Messages render with new architecture
- [ ] Edit tool shows diff view
- [ ] Copy buttons work
- [ ] No TypeScript/runtime errors
- [ ] Tool registry initialized
- [ ] Theme system applied consistently

---

## 🚀 After Testing

Once verified working:

### Phase 2: Add More Tool Renderers
1. BashToolRenderer (terminal output)
2. WriteToolRenderer (file creation)
3. ReadToolRenderer (file content)
4. GrepToolRenderer (search results)

### Phase 3: Shared Components
1. CodeBlock with syntax highlighting
2. DiffView improvements
3. JsonViewer (collapsible)
4. TerminalOutput (ANSI colors)

### Phase 4: Polish
1. Animations (expand/collapse)
2. Performance optimization
3. Unit tests
4. Documentation

---

## 📸 Expected UI

### Edit Tool Example
```
▼ 📝 Edit                           ✓ Applied
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📁 src/features/workspace/components/MessageItem.tsx

┌────────────────────┬─────────────────────┐
│ − Before [📋 Copy] │ + After [📋 Copy]   │
├────────────────────┼─────────────────────┤
│ Old code...        │ New code...         │
└────────────────────┴─────────────────────┘
```

### Default Tool Example
```
▶ 🔧 Bash                           ✓

Input:
{
  "command": "npm run dev",
  "description": "Start dev server"
}
```

---

## 🆘 Troubleshooting

### App won't load
```bash
# Restart services
pkill -f "vite|node.*server"
npm run dev:full
```

### Backend not responding
```bash
# Check backend port
curl http://localhost:50228/api/health

# Should return:
# {"status":"ok","port":50228,...}
```

### No messages showing
- Check workspace is selected
- Check session has messages (API endpoint)
- Check browser console for errors

---

**Ready to test!** 🎉

Open http://localhost:1420 and navigate to the palenque workspace.
