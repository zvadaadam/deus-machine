# Feedback on `latest_message_sent_at` Approach

## Summary of Changes

✅ **What You Did:**
- Removed `working_started_at` column entirely
- Used SQL subquery to get `sent_at` from the latest user message
- Renamed all props: `workingStartedAt` → `latestMessageSentAt`
- Added session cancellation endpoint (POST /api/sessions/:id/stop)
- Cleaner approach using existing data

## The Problem

⚠️ **Critical Issue: Duration Resets on Follow-up Messages**

### Scenario:
```
10:00:00 - User: "Fix the authentication bug"
          → Session starts working
          → latest_message_sent_at = "10:00:00"
          → Duration: 5s... 10s... 45s... 1m 30s...

10:01:30 - User: "Also add unit tests please"
          → Session STILL working on first message
          → latest_message_sent_at = "10:01:30" ❌ UPDATED!
          → Duration RESETS to: 5s... 10s...
          → Should show: "1m 35s" but shows "5s" instead
```

### Why This Happens:

Your SQL query:
```sql
(SELECT sent_at FROM session_messages
 WHERE session_id = s.id AND role = 'user'
 ORDER BY created_at DESC LIMIT 1) as latest_message_sent_at
```

This **always returns the LATEST user message**, not the message that **started** the current work session.

## The Root Cause

**What we need:** Timestamp when session **started working** (idle → working transition)
**What we're getting:** Timestamp of **most recent user message**

These are different because:
- Users can send multiple messages while Claude is still working
- Each new message updates `latest_message_sent_at`
- Duration counter resets unexpectedly

## Solutions

### Option 1: Revert to `working_started_at` (Recommended) ✅

**Pros:**
- Simple, explicit, correct
- Only one column added
- No edge cases
- Duration never resets unexpectedly

**Cons:**
- Adds one column to database

**Implementation:**
```sql
-- When message arrives and session transitions to working
UPDATE sessions
SET status = 'working',
    working_started_at = datetime('now')
WHERE id = ? AND status != 'working';

-- When session completes
UPDATE sessions
SET status = 'idle',
    working_started_at = NULL
WHERE id = ?;
```

### Option 2: Get First Uncancelled User Message While Working

Keep your approach but modify the query:

```sql
(SELECT sent_at FROM session_messages
 WHERE session_id = s.id
   AND role = 'user'
   AND cancelled_at IS NULL
   AND sent_at >= (
     SELECT MAX(created_at) FROM session_messages
     WHERE session_id = s.id
       AND role = 'assistant'
       AND content LIKE '%"type":"result"%'
   )
 ORDER BY created_at ASC LIMIT 1) as working_started_at
```

**Pros:**
- No new column

**Cons:**
- Complex query (performance impact)
- Runs on every workspace fetch
- Fragile (depends on message content structure)
- Edge cases (what if messages deleted, compacted, etc.)

### Option 3: Hybrid Approach

Use `last_user_message_at` session field (already exists) but only update it when status changes to working:

```javascript
// Only update when transitioning to working
if (currentStatus !== 'working') {
  db.prepare(`
    UPDATE sessions
    SET status = 'working',
        last_user_message_at = datetime('now')
    WHERE id = ?
  `).run(sessionId);
}
```

**Pros:**
- Uses existing column
- No new column

**Cons:**
- Repurposes a field meant for different purpose
- Confusing semantics (last_user_message_at doesn't mean "last message")
- Still need to clear it on idle

## Recommendation

**Go back to `working_started_at` approach** for these reasons:

1. ✅ **Semantically Clear** - Field name matches its purpose
2. ✅ **No Edge Cases** - Doesn't depend on message state
3. ✅ **Performant** - No complex queries
4. ✅ **Maintainable** - Easy to understand
5. ✅ **Correct** - Duration never resets unexpectedly

The cost is just one column, which is worth it for correctness and simplicity.

## Other Changes (Good!)

✅ **Session Cancellation** - Great addition!
- Marks message as cancelled with `cancelled_at` timestamp
- Stops Claude process properly
- Good UX improvement

✅ **Code Quality** - Well implemented
- Consistent prop naming
- Type safety maintained
- Clean refactoring

## Next Steps

If you want to keep the no-new-column approach, you must:

1. Test the multi-message scenario
2. Verify duration doesn't reset
3. If it does (it will), implement Option 2 or revert to Option 1

**My strong recommendation:** Revert to `working_started_at`. One column is worth the correctness.
