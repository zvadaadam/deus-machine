# Should We Use `last_user_message_at` Instead?

## Current Approach: `working_started_at`
✅ Set when status → 'working' (first message only)
✅ Stays constant while session is working
✅ Cleared when status → 'idle'
✅ Perfect for duration tracking

## Alternative: `last_user_message_at`
❌ **Problem**: Updates on EVERY user message
❌ **Scenario**: User sends follow-up messages while Claude is working
❌ **Result**: Duration resets to 0 on each message

## Test Scenario:

1. **User sends message 1** at 10:00:00
   - Session → 'working'
   - `last_user_message_at` = 10:00:00
   - Duration starts counting: "5s", "10s", "15s"...

2. **User sends message 2** at 10:01:30 (while Claude still working)
   - Session still 'working'
   - `last_user_message_at` = 10:01:30 ❌
   - Duration **resets to 0** - shows "5s" instead of "1m 35s"

## Why We Need `working_started_at`:

The key difference:
- `last_user_message_at` = **when user last typed something**
- `working_started_at` = **when Claude started this work session**

For duration tracking, we need to know:
- "How long has Claude been working on this session?"
- NOT "How long since the last message?"

## Verdict: ✅ Keep `working_started_at`

We need a timestamp that:
1. Only sets when status transitions idle → working
2. Doesn't change during the working session
3. Clears when session finishes

`last_user_message_at` doesn't meet these requirements because it updates on every user message, which would cause the duration counter to reset unexpectedly.

## Alternative: Could We Avoid a New Column?

**Option 1:** Query the first user message timestamp when status is working
- ❌ Complex query on every render
- ❌ Performance issues
- ❌ Doesn't handle edge cases (deleted messages, etc.)

**Option 2:** Use `updated_at`
- ❌ Updates on ANY session change (compacting, status, etc.)
- ❌ Not reliable

**Option 3:** Add `working_started_at` column
- ✅ Simple, explicit, performant
- ✅ Clear semantics
- ✅ Easy to maintain
- **This is the right approach**
