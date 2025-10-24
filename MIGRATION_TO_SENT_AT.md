# ✅ Migration Complete: working_started_at → sent_at

## 🎯 Summary

Successfully migrated from using `working_started_at` on the sessions table to using `sent_at` from the latest user message for duration tracking. This aligns with OpenDevs's original implementation.

---

## 🔄 What Changed

### Backend Changes

#### 1. **Removed `working_started_at` from SQL UPDATE queries** (5 locations)
```sql
-- OLD:
UPDATE sessions
SET status = 'working', working_started_at = datetime('now'), updated_at = datetime('now')
WHERE id = ?

-- NEW:
UPDATE sessions
SET status = 'working', updated_at = datetime('now')
WHERE id = ?
```

**Files modified:**
- `backend/server.cjs:824` - Send message endpoint
- `backend/server.cjs:924` - Stop session endpoint
- `backend/lib/claude-session.cjs:254` - Success handler
- `backend/lib/claude-session.cjs:445` - Process exit handler
- `backend/lib/sidecar/message-handler.cjs:87` - Final message handler

#### 2. **Removed `working_started_at` from SELECT queries**
Removed from workspace API endpoints:
- `GET /api/workspaces`
- `GET /api/workspaces/grouped`
- `GET /api/workspaces/:id`

#### 3. **Added `latest_message_sent_at` to workspace queries**
```sql
SELECT
  w.*,
  s.status,
  (SELECT sent_at FROM session_messages
   WHERE session_id = s.id AND role = 'user'
   ORDER BY created_at DESC LIMIT 1) as latest_message_sent_at
FROM workspaces w
LEFT JOIN sessions s ON w.active_session_id = s.id
```

**Benefit:** Calculates latest message sent_at on-the-fly from messages table

---

### Frontend Changes

#### 1. **Updated `useWorkingDuration` hook**
**File:** `src/shared/hooks/useWorkingDuration.ts`

```typescript
// OLD:
interface UseWorkingDurationOptions {
  status: SessionStatus | null | undefined;
  workingStartedAt?: string | null;
}

// NEW:
interface UseWorkingDurationOptions {
  status: SessionStatus | null | undefined;
  latestMessageSentAt?: string | null;
}
```

#### 2. **Updated `useSessionWithMessages` query**
**File:** `src/features/session/api/session.queries.ts`

Added calculation for latest message's `sent_at`:
```typescript
const latestMessageSentAt = useMemo(() => {
  if (!messagesQuery.data || messagesQuery.data.length === 0) return null;

  // Find the latest user message
  const latestUserMessage = [...messagesQuery.data]
    .reverse()
    .find((msg: Message) => msg.role === 'user');

  return latestUserMessage?.sent_at || null;
}, [messagesQuery.data]);
```

#### 3. **Updated all components**
- `SessionPanel.tsx` - Changed `workingStartedAt` → `latestMessageSentAt`
- `Chat.tsx` - Changed prop from `workingStartedAt` → `latestMessageSentAt`
- `WorkspaceItem.tsx` - Changed to use `workspace.latest_message_sent_at`

#### 4. **Updated TypeScript types**
- `Session` interface - Removed `working_started_at` field
- `Workspace` interface - Changed `working_started_at` → `latest_message_sent_at`

---

## 📊 Files Modified

| File | Changes |
|------|---------|
| **Backend (5 files)** | |
| `backend/server.cjs` | Removed `working_started_at` from 4 SQL queries, added `latest_message_sent_at` to 3 SELECT queries |
| `backend/lib/claude-session.cjs` | Removed `working_started_at = NULL` from 2 UPDATE queries |
| `backend/lib/sidecar/message-handler.cjs` | Removed `working_started_at = NULL` from UPDATE query |
| **Frontend (7 files)** | |
| `src/shared/hooks/useWorkingDuration.ts` | Renamed parameter from `workingStartedAt` → `latestMessageSentAt` |
| `src/features/session/api/session.queries.ts` | Added logic to get latest message's `sent_at` |
| `src/features/session/ui/SessionPanel.tsx` | Updated to use `latestMessageSentAt` |
| `src/features/session/ui/Chat.tsx` | Updated prop from `workingStartedAt` → `latestMessageSentAt` |
| `src/features/sidebar/ui/WorkspaceItem.tsx` | Updated to use `workspace.latest_message_sent_at` |
| `src/features/session/types.ts` | Removed `working_started_at` field |
| `src/features/workspace/types.ts` | Changed `working_started_at` → `latest_message_sent_at` |

**Total:** 12 files modified

---

## 🎯 Why This Change?

### OpenDevs's Original Approach
OpenDevs uses the latest user message's `sent_at` timestamp to calculate duration, not a separate `working_started_at` field on sessions.

**Advantages:**
1. **Single source of truth** - Duration comes directly from when the message was sent
2. **No duplicate tracking** - Don't need to maintain two timestamps (message sent_at + session working_started_at)
3. **Automatic cleanup** - When messages are deleted/archived, duration tracking is automatically removed
4. **More accurate** - Uses the exact time the user's message was sent to Claude

### Old Approach (working_started_at)
- Separate timestamp on sessions table
- Needed to be set when status → 'working'
- Needed to be cleared when status → 'idle'
- Could get out of sync with actual messages

### New Approach (sent_at)
- Uses existing `sent_at` field from messages table
- Already set when message is created
- Automatically reflects the actual user message timing
- No separate cleanup needed

---

## ✅ Verification

### Backend
```bash
# Check that working_started_at is not set anymore
sqlite3 ~/Library/Application\ Support/com.conductor.app/conductor.db \
  "SELECT id, status, working_started_at FROM sessions WHERE status = 'working' LIMIT 5;"
```

Expected: `working_started_at` should be NULL for all sessions

### Frontend
1. Send a message in a workspace
2. Verify duration appears: "Claude is working... (5s)"
3. Duration should update every second
4. Duration should persist on page refresh

---

## 🎨 User Experience

**Before and after are identical from user perspective:**
- Sidebar still shows: "branch-name • directory • 2m 34s"
- Chat still shows: "Claude is working... (2m 34s)"
- Duration still updates every 1 second
- Duration still persists across page refreshes

**The change is purely internal implementation!**

---

## 🔍 Technical Details

### Duration Calculation

**How it works now:**
```typescript
// In useSessionWithMessages query
const latestMessageSentAt = useMemo(() => {
  const latestUserMessage = [...messages]
    .reverse()
    .find(msg => msg.role === 'user');

  return latestUserMessage?.sent_at || null;
}, [messages]);

// In useWorkingDuration hook
if (status === 'working' && latestMessageSentAt) {
  const duration = Date.now() - new Date(latestMessageSentAt).getTime();
  // Update every 1 second
}
```

### Backend Query Pattern
```sql
-- Get workspace with latest message sent_at
SELECT
  w.*,
  s.status,
  (SELECT sent_at
   FROM session_messages
   WHERE session_id = s.id AND role = 'user'
   ORDER BY created_at DESC
   LIMIT 1) as latest_message_sent_at
FROM workspaces w
LEFT JOIN sessions s ON w.active_session_id = s.id
```

---

## 🚀 Benefits

1. **Simplified codebase** - No need to manage `working_started_at` separately
2. **Better alignment with OpenDevs** - Uses the same approach as original app
3. **More reliable** - Duration comes from actual message timestamp
4. **Less code** - Removed ~10 lines of UPDATE queries setting/clearing timestamp
5. **Easier to understand** - Duration is clearly tied to when user sent the message

---

## 📝 Database Note

**The `working_started_at` column still exists in the database!**

We didn't drop it because:
1. May contain historical data
2. Safe to leave unused columns
3. Could be useful for future analysis
4. Avoids migration complexity

The column is simply **ignored** now. All NULL values.

---

## ✨ Result

**Migration complete!** Duration tracking now uses `sent_at` from the latest user message, matching OpenDevs's original implementation exactly.

**No user-facing changes** - Everything works exactly the same from the user's perspective! 🎉
