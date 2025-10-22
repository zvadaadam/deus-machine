# 🐛 REFACTORING BUGS FOUND

**Date:** 2025-10-21
**Status:** ❌ CRITICAL ISSUES - App Not Functional
**Context:** Post-refactoring verification found multiple critical runtime bugs

---

## 🚨 CRITICAL ISSUES

### 1. **Messages Not Loading in Workspace** ❌ BLOCKING

**Symptom:**
- When opening a workspace, the chat panel shows NO messages
- Backend API has 93 messages for session `31b77720-27f6-49c4-8280-310bad6c1bee`
- Frontend displays empty state or nothing

**Evidence:**
```bash
# Backend has messages
curl http://localhost:57700/api/sessions/31b77720-27f6-49c4-8280-310bad6c1bee/messages
# Returns 93 messages ✅

# Frontend shows: EMPTY or loading state ❌
```

**Possible Causes:**
1. ❓ Query hook not being called
2. ❓ SessionPanel not rendering
3. ❓ Import/export issue with `useSessionWithMessages`
4. ❓ React Query configuration issue
5. ❓ MessageItem filtering all messages as empty

**Files to Check:**
- `src/features/session/ui/SessionPanel.tsx:47-54` - useSessionWithMessages hook
- `src/features/session/api/session.queries.ts:51-95` - useSessionWithMessages implementation
- `src/features/session/ui/Chat.tsx:48` - messages.length === 0 check
- `src/features/session/ui/MessageItem.tsx:28-38` - hasRenderableContent filter

**Priority:** 🔴 P0 - BLOCKS ALL CHAT FUNCTIONALITY

---

### 2. **Workspace Creation May Be Broken** ⚠️ UNTESTED

**Status:** Not yet tested but likely broken

**To Test:**
1. Click "Create Workspace" button
2. Select repository
3. Check if workspace gets created
4. Check console for errors

**Priority:** 🔴 P0 - BLOCKS NEW WORKSPACES

---

### 3. **Expected Non-Critical Errors** ℹ️ KNOWN

These are expected in web mode and NOT bugs:

1. **Tauri APIs Unavailable**
   - "Cannot read properties of undefined (reading 'invoke')"
   - Affects: OpenInDropdown, File dialogs
   - ✅ Expected in web dev mode

2. **Browser Panel Connection Failed**
   - "Failed to fetch http://localhost:3000/health"
   - dev-browser not auto-starting
   - ✅ Expected - requires separate setup

3. **Missing System Prompt Endpoint**
   - `/api/workspaces/:id/system-prompt` returns 404
   - ✅ Known - not yet implemented

---

## 📊 TEST RESULTS

### Backend Tests ✅
- ✅ Backend server running (port 57700)
- ✅ Health endpoint working
- ✅ Messages API working (93 messages returned)
- ✅ Workspaces API working
- ✅ Database connected (202 workspaces, 60K+ messages)

### Frontend Tests ❌
- ❌ Messages not displaying
- ❓ Workspace creation (not tested)
- ❓ Message sending (not tested)
- ❓ File changes panel (not tested)
- ❓ Terminal panel (not tested)

---

## 🔍 INVESTIGATION NEEDED

### Why Aren't Messages Loading?

**Hypothesis 1: Query Not Running**
```typescript
// In SessionPanel.tsx:47-54
const {
  messages,
  sessionStatus,
  isCompacting,
  loading,
  parseContent,
  toolResultMap,
} = useSessionWithMessages(sessionId);

// Is sessionId valid? Is query enabled?
```

**To Debug:**
1. Add console.log in SessionPanel to check `sessionId` value
2. Add console.log in `useSessionWithMessages` to see if it's called
3. Check React Query DevTools (available in app)
4. Check if `enabled: !!sessionId` is working correctly

**Hypothesis 2: Messages Filtered Out**
```typescript
// In MessageItem.tsx:28-38
const hasRenderableContent = Array.isArray(contentBlocks) &&
  contentBlocks.length > 0 &&
  contentBlocks.some((block: any) => block.type !== 'tool_result');

if (!hasRenderableContent) {
  return null; // ← Could be filtering ALL messages?
}
```

**To Debug:**
1. Check what `parseContent` returns for actual messages
2. Add logging to see which messages are being filtered
3. Check if all 93 messages have `type === 'tool_result'`

---

## 🎯 NEXT STEPS

### Immediate Actions (P0)

1. **Add Debug Logging**
   ```typescript
   // In SessionPanel.tsx
   console.log('[SessionPanel] sessionId:', sessionId);
   console.log('[SessionPanel] messages:', messages.length);
   console.log('[SessionPanel] loading:', loading);
   ```

2. **Check React Query DevTools**
   - Open TanStack Query DevTools (button visible in app)
   - Check if messages query is running
   - Check if it's enabled
   - Check query result

3. **Test Message Parsing**
   ```typescript
   // Test parseContent with real message
   const testMessage = messages[0];
   const parsed = parseContent(testMessage.content);
   console.log('Parsed content:', parsed);
   ```

4. **Fix Root Cause**
   - Once identified, fix the issue
   - Test with real data
   - Verify messages load

### Secondary Actions (P1)

1. Test workspace creation
2. Test message sending
3. Test all other features
4. Update REFACTORING_VERIFICATION.md with actual test results

---

## 📝 NOTES

- The refactoring **structurally succeeded** (no TypeScript errors, builds fine)
- The refactoring **functionally failed** (critical features broken at runtime)
- This is a common pattern: structure is correct, but logic has bugs
- Need to identify if bugs were introduced during refactoring or existed before

---

**Status:** 🔴 INVESTIGATION IN PROGRESS
**Next Update:** After debugging messages issue
