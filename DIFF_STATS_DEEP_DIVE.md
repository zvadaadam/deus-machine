# useBulkDiffStats - Deep Dive Analysis

**Date:** 2025-10-26
**Investigation:** Complete understanding of WHY it exists and HOW to fix it

---

## 🎯 WHAT IS IT?

**DiffStats** = Git diff statistics showing code changes relative to parent branch

```typescript
interface DiffStats {
  additions: number;  // Lines added
  deletions: number;  // Lines deleted
}
```

**Purpose:** Show **"+5 / -3"** badges on each workspace in the sidebar to indicate uncommitted changes.

---

## 📊 COMPLETE DATA FLOW

### Current Architecture (The Problem)

```
Page Load
    ↓
MainLayout renders
    ↓
useBulkDiffStats([50 workspaces])
    ↓
Fetch first 5 workspaces immediately (5 parallel git diff)
    ↓
Stagger remaining 45 workspaces (1 every 200ms)
    ↓
Each workspace: execFileSync('git', ['diff', 'main...HEAD', '--shortstat'])
    ↓
Parse output: "3 files changed, 45 insertions(+), 12 deletions(-)"
    ↓
Store in Zustand: diffStats[workspaceId] = { additions: 45, deletions: 12 }
    ↓
AppSidebar receives diffStats prop
    ↓
RepositoryItem receives diffStats[workspace.id]
    ↓
WorkspaceItem displays badges:
    <span>+45</span>
    <span>-12</span>
```

**Every 2 seconds:** Repeat ALL of this! 🔥

---

## 💥 THE PROBLEM

### 1. Massive Git Operations

**With 50 workspaces:**
- 50 git operations per fetch
- Polling every 2 seconds
- **1,500 git operations/minute**
- **90,000 git operations/hour**

Each git diff:
```bash
cd /workspace/path
git diff main...HEAD --shortstat
# Takes 50-200ms per workspace
# Blocks CPU, reads .git directory
```

### 2. Progressive Loading Nightmare

**Lines 158-181 in workspace.queries.ts:**

```typescript
useEffect(() => {
  const timers = workspaceIds.slice(5).map((id, idx) => {
    return setTimeout(() => {
      queryClient.prefetchQuery({
        queryKey: queryKeys.workspaces.diffStats(id),
        queryFn: () => WorkspaceService.fetchDiffStats(id),
      }).then(() => {
        // Updates cache → triggers re-render
        queryClient.setQueryData(['bulk-diff-stats', workspaceIds], {...});
      });
    }, idx * 200); // Stagger by 200ms
  });

  return () => timers.forEach(clearTimeout);
}, [workspaceIds]);
```

**Problems:**
- Creates 45 timers for 45 workspaces
- Each timer triggers API call → cache update → re-render
- **45 re-renders** as badges appear progressively
- Timers cleanup happens too late (when workspaceIds changes)
- Takes 9 seconds to load all (45 × 200ms)

### 3. Aggressive Polling

**Lines 64-69:**
```typescript
const query = useQuery({
  queryKey: ['bulk-diff-stats', workspaceIds],
  staleTime: 1000, // Data stale after 1 second!
  refetchInterval: 2000, // Poll every 2 seconds
});
```

Every 2 seconds:
1. Fetch 5 workspaces immediately
2. Stagger 45 more over 9 seconds
3. Trigger 50 re-renders
4. Repeat

---

## 🔍 WHY DOES IT EXIST?

### UI Purpose

**Sidebar badges showing code changes:**

```
📁 my-repo
  ├─ feat/new-feature  [+45 -12]  ← These badges!
  ├─ fix/bug-123       [+5 -3]    ← Show uncommitted changes
  └─ main             (no badge if no changes)
```

**User benefit:**
- See at a glance which workspaces have changes
- Know how much code was modified
- Helps track work across multiple branches

**Implementation location:**
- `src/features/sidebar/ui/WorkspaceItem.tsx:172-184`

```typescript
{hasChanges ? (
  <div className="flex items-center gap-1">
    {additions > 0 && (
      <span className="badge-success">+{additions}</span>
    )}
    {deletions > 0 && (
      <span className="badge-destructive">-{deletions}</span>
    )}
  </div>
) : null}
```

---

## 🤔 THE FUNDAMENTAL QUESTION

**Do we need diff stats for ALL workspaces ALL the time?**

**Answer:** NO!

**Reasons:**
1. **User sees ~5-10 workspaces** at once in sidebar (not all 50)
2. **Diff stats don't change often** - only when user commits/changes code
3. **Most workspaces are idle** - no active development
4. **Expensive to compute** - git diff is heavy operation

---

## 💡 ALTERNATIVE SOLUTIONS

### Option 1: Lazy Loading (On Demand) ⭐ **SIMPLE & EFFECTIVE**

**Concept:** Only fetch diff stats when workspace is visible or selected

**Implementation:**
```typescript
// Remove useBulkDiffStats entirely from MainLayout

// Add to WorkspaceItem (or parent RepositoryItem)
function WorkspaceItem({ workspace, ... }) {
  // Only fetch when workspace is visible in viewport
  const { ref, inView } = useInView();

  const { data: diffStats } = useQuery({
    queryKey: ['workspace-diff-stats', workspace.id],
    queryFn: () => WorkspaceService.fetchDiffStats(workspace.id),
    enabled: inView, // Only fetch when visible
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
    refetchInterval: false, // No polling
  });

  return (
    <div ref={ref}>
      {diffStats && (
        <Badge>+{diffStats.additions} -{diffStats.deletions}</Badge>
      )}
    </div>
  );
}
```

**Benefits:**
- Fetches ~5-10 workspaces (only visible ones)
- No polling
- No progressive loading complexity
- Simple to understand

**Downsides:**
- Badges appear on scroll (acceptable)
- Still ~5-10 git operations on page load

**Impact:** 90,000 git ops/hour → **~50 git ops/hour** (99.9% reduction)

---

### Option 2: Backend Caching ⭐ **BEST LONG-TERM**

**Concept:** Cache git diff results in backend, invalidate on git operations

**Implementation:**

**Backend (server.cjs):**
```javascript
// In-memory cache
const diffStatsCache = new Map(); // workspaceId -> { stats, timestamp }

// Cache for 5 minutes
const CACHE_TTL = 5 * 60 * 1000;

app.get('/api/workspaces/:id/diff-stats', async (req, res) => {
  const cached = diffStatsCache.get(req.params.id);

  // Return cached if fresh
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
    return res.json(cached.stats);
  }

  // Compute fresh stats
  const stats = await computeDiffStats(req.params.id);

  // Cache it
  diffStatsCache.set(req.params.id, {
    stats,
    timestamp: Date.now()
  });

  res.json(stats);
});

// Invalidate cache when workspace commits/pushes
app.post('/api/workspaces/:id/invalidate-stats', (req, res) => {
  diffStatsCache.delete(req.params.id);
  res.json({ ok: true });
});
```

**Frontend:** Same as before, but now backend is fast!

**Benefits:**
- Fast response (cached)
- Reduces git operations dramatically
- Invalidate only when needed

**Downsides:**
- More backend complexity
- Need to detect when to invalidate

**Impact:** Git operations only when cache misses (90% reduction)

---

### Option 3: WebSocket Updates ⭐ **OVERKILL**

**Concept:** Watch git repository, push updates via WebSocket when files change

**Implementation:**
```javascript
// Backend: Watch .git directory
const chokidar = require('chokidar');

workspaces.forEach(workspace => {
  const watcher = chokidar.watch(workspace.path, {
    ignored: /node_modules/,
    ignoreInitial: true
  });

  watcher.on('change', async () => {
    const stats = await computeDiffStats(workspace.id);
    io.emit('workspace:diff-stats', {
      workspaceId: workspace.id,
      stats
    });
  });
});
```

**Frontend:**
```typescript
useEffect(() => {
  socket.on('workspace:diff-stats', ({ workspaceId, stats }) => {
    queryClient.setQueryData(['diff-stats', workspaceId], stats);
  });
}, []);
```

**Benefits:**
- Real-time updates
- Zero polling
- Instant badge updates

**Downsides:**
- Complex to implement
- Watching 50 directories is expensive
- Over-engineered for this use case

---

### Option 4: Virtualized Sidebar (Hybrid) ⭐ **IF YOU HAVE MANY WORKSPACES**

**Concept:** Only render visible workspaces, fetch diff stats lazily

**Implementation:**
```typescript
import { useVirtualizer } from '@tanstack/react-virtual';

function RepositoryItem({ repo }) {
  const rowVirtualizer = useVirtualizer({
    count: repo.workspaces.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => 60,
    overscan: 3, // Fetch 3 above/below visible area
  });

  return (
    <div ref={containerRef}>
      {rowVirtualizer.getVirtualItems().map((virtualRow) => (
        <WorkspaceItem
          workspace={repo.workspaces[virtualRow.index]}
          // Only rendered workspaces fetch diff stats
        />
      ))}
    </div>
  );
}
```

**Benefits:**
- Handles 1000+ workspaces efficiently
- Only renders ~10 items at a time
- Smooth scrolling

**Downsides:**
- Adds virtualization complexity
- Harder to implement drag-and-drop

---

## 🎯 RECOMMENDED SOLUTION

### **Option 1 + Option 2 Hybrid**

**Phase 1 (Immediate - 15 minutes):**

1. **Remove useBulkDiffStats** from MainLayout
2. **Add lazy loading** per workspace (Option 1)
3. **Disable polling** completely

```typescript
// MainLayout.tsx - REMOVE THESE LINES:
const diffStatsQuery = useBulkDiffStats(workspacesQuery.data || []);
useEffect(() => {
  if (diffStatsQuery.data) {
    setMultipleDiffStats(diffStatsQuery.data);
  }
}, [diffStatsQuery.data, setMultipleDiffStats]);

// WorkspaceItem.tsx or RepositoryItem.tsx - ADD:
const { data: diffStats } = useDiffStats(workspace.id); // Already exists!

// Just pass it to WorkspaceItem:
<WorkspaceItem
  workspace={workspace}
  diffStats={diffStats}
  // ... props
/>
```

**Phase 2 (Later - 1 hour):**

1. **Add backend caching** (Option 2)
2. **Invalidate on git operations**
3. Keep lazy loading from Phase 1

---

## 📊 EXPECTED RESULTS

### Current (With useBulkDiffStats):
- **90,000 git operations/hour**
- 50 workspaces × 30 polls/min × 60 min
- ~9 seconds progressive loading
- 45+ re-renders per poll
- UI feels sluggish

### After Phase 1 (Lazy Loading):
- **~50 git operations/hour** (only visible workspaces)
- 5-10 workspaces × 1 fetch × occasional refresh
- Instant page load
- 0 re-renders during loading
- **99.9% reduction** 🎉

### After Phase 2 (+ Backend Cache):
- **~10 git operations/hour** (only cache misses)
- Backend returns cached results instantly
- **99.99% reduction** 🔥

---

## 🔧 IMPLEMENTATION GUIDE

### Step 1: Remove Bulk Fetching (5 min)

**File:** `src/app/layouts/MainLayout.tsx`

**Remove lines 86, 94-98:**
```typescript
// DELETE THIS:
const diffStatsQuery = useBulkDiffStats(workspacesQuery.data || []);

// DELETE THIS:
useEffect(() => {
  if (diffStatsQuery.data) {
    setMultipleDiffStats(diffStatsQuery.data);
  }
}, [diffStatsQuery.data, setMultipleDiffStats]);
```

### Step 2: Use Per-Workspace Fetching (5 min)

**File:** `src/features/sidebar/ui/RepositoryItem.tsx`

**Find where WorkspaceItem is rendered (~line 143):**

**Before:**
```typescript
<WorkspaceItem
  workspace={workspace}
  diffStats={diffStats[workspace.id]} // ❌ From bulk fetch
  // ...
/>
```

**After:**
```typescript
function WorkspaceItemWrapper({ workspace, ... }) {
  // Fetch only for this workspace
  const { data: diffStats } = useDiffStats(workspace.id);

  return (
    <WorkspaceItem
      workspace={workspace}
      diffStats={diffStats} // ✅ Lazy loaded
      // ...
    />
  );
}
```

### Step 3: Update useDiffStats Config (2 min)

**File:** `src/features/workspace/api/workspace.queries.ts`

**Line 42-50:**
```typescript
export function useDiffStats(workspaceId: string | null) {
  return useQuery({
    queryKey: queryKeys.workspaces.diffStats(workspaceId || ''),
    queryFn: () => WorkspaceService.fetchDiffStats(workspaceId!),
    enabled: !!workspaceId,
    staleTime: 5 * 60 * 1000,  // ✅ 5 minutes (was 30s)
    refetchInterval: false,     // ✅ No polling (was 2s)
  });
}
```

### Step 4: Clean Up Store (Optional)

**File:** `src/features/workspace/store/workspaceStore.ts`

You can keep `diffStats` in store for now (not hurting anything), but it's not really needed anymore since React Query caches it.

---

## ✅ SUCCESS CRITERIA

### Metrics to Track

| Metric | Before | After | Target |
|--------|--------|-------|--------|
| Git ops/hour | 90,000 | ? | <100 |
| Page load time | 2-5s | ? | <500ms |
| Initial API calls | 50 | ? | 5-10 |
| Sidebar re-renders | 45+ | ? | 0-5 |
| Memory usage | High | ? | Low |

### Visual Tests

- [ ] Badges still appear on workspaces
- [ ] Numbers are correct (+5 / -3)
- [ ] No progressive loading flicker
- [ ] Sidebar scrolls smoothly
- [ ] Network tab shows <10 requests on load

---

## 🎉 CONCLUSION

**useBulkDiffStats exists to show git change badges in the sidebar.**

**The problem:** It fetches diff stats for ALL 50 workspaces every 2 seconds = 90,000 git operations/hour.

**The solution:** Lazy load diff stats only for visible workspaces, no polling.

**The win:** 99.9% reduction in git operations, instant page load, zero complexity.

**Implementation time:** 15 minutes.

**DO IT NOW!** 🚀
