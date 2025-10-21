# Backend Crash Bug - Message Send Failure

## Problem Description

The backend server (`backend/server.cjs`) crashes silently when processing message send requests from the frontend. This prevents users from sending messages in the chat interface.

## Symptoms

1. **User Experience**: When typing a message in the chat input and clicking send, nothing happens
2. **Backend Behavior**: Backend process dies/crashes without error logs
3. **Frontend Errors**: Browser console shows:
   - `ERR_CONNECTION_RESET` (first request that triggers crash)
   - `ERR_CONNECTION_REFUSED` (subsequent requests after backend is dead)

## How to Reproduce

1. Start the app with `npm run dev:full`
2. Navigate to any workspace (e.g., "escape-key-selector")
3. Type a message in the chat input at the bottom
4. Click send
5. **Result**: Backend crashes, message is not sent

## What We Know

### Backend Details
- **File**: `backend/server.cjs`
- **Startup**: Backend starts successfully on a dynamic port (e.g., 52023)
- **Process**: Gets a PID (e.g., 65751) and runs initially
- **Crash Point**: Dies when processing POST request to send message (likely `/api/sessions/{id}/messages` endpoint)
- **No Error Logs**: Process crashes silently without outputting errors

### Frontend Details
- Frontend connects to backend successfully on startup
- Frontend can load messages from backend (GET requests work)
- Frontend cannot send messages (POST requests trigger crash)

### What Works
- ✅ Backend starts successfully
- ✅ Frontend connects to backend
- ✅ Message loading (GET requests)
- ✅ Displaying existing messages in workspace

### What Doesn't Work
- ❌ Sending new messages (POST requests)
- ❌ Backend stays alive after send attempt

## Investigation Steps

### 1. Check Backend Logs
```bash
# Start the app
npm run dev:full

# In another terminal, tail backend logs if they exist
# Or check the dev.sh output for backend stderr/stdout
```

### 2. Test Backend Endpoint Directly
```bash
# Get the backend port from dev.sh output (e.g., 52023)
# Try to send a test message directly:
curl -X POST http://localhost:52023/api/sessions/c8870e89-5adc-4a39-8e99-d1979928536b/messages \
  -H "Content-Type: application/json" \
  -d '{"content": "test message"}'

# Check if backend crashes
ps aux | grep "node backend/server.cjs"
```

### 3. Add Debug Logging
Edit `backend/server.cjs` to add debug logging:
```javascript
// Add at the start of message send handler
app.post('/api/sessions/:sessionId/messages', async (req, res) => {
  console.log('[DEBUG] Received message send request:', {
    sessionId: req.params.sessionId,
    body: req.body,
    headers: req.headers
  });

  try {
    // ... existing code
  } catch (error) {
    console.error('[ERROR] Message send failed:', error);
    throw error;
  }
});
```

### 4. Check for Uncaught Exceptions
Add global error handlers in `backend/server.cjs`:
```javascript
process.on('uncaughtException', (error) => {
  console.error('[FATAL] Uncaught Exception:', error);
  console.error(error.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
});
```

## Potential Root Causes

1. **Null/Undefined Reference**: Backend code accessing undefined property when processing message
2. **Database/Socket Error**: Error in Claude Code CLI socket communication
3. **Memory Issue**: Out of memory or resource exhaustion
4. **Async/Promise Error**: Unhandled promise rejection
5. **Invalid Request Data**: Backend expecting different message format than frontend sends

## Files to Investigate

- `backend/server.cjs` - Main backend server file
- `src/features/session/api/sessionApi.ts` - Frontend API calls
- `src/features/session/ui/SessionPanel.tsx` - Message send UI component

## Fix Prompt

**Task**: Debug and fix the backend crash that occurs when sending messages.

**Steps**:
1. Add comprehensive error logging to `backend/server.cjs`
2. Add global error handlers for uncaught exceptions and unhandled rejections
3. Reproduce the crash and capture the error
4. Identify the exact line/operation that causes the crash
5. Fix the underlying issue (likely null check, error handling, or data validation)
6. Test that messages can be sent successfully
7. Verify backend stays alive after multiple message sends

**Expected Outcome**:
- Backend remains stable when processing message send requests
- Users can successfully send messages in the chat
- Proper error handling prevents crashes
- Clear error messages when issues occur

## Related Context

- This issue is NOT related to the recent FSD-Lite refactoring
- Message loading works fine (backend handles GET requests successfully)
- Only POST requests for sending messages trigger the crash
- Previous crash was on port 65434 with PID 12259, now on port 52023 with PID 65751 - consistent across restarts
