# 🔥 CRITICAL Performance Fixes TODO

**Current Status:** Website still unusable after fixing polling
**Why:** We fixed 1/5 critical issues - 4 more killers remain!

---

## 🚨 PRIORITY 1: IMMEDIATE FIXES (Next 30 minutes)

### 1. Kill useBulkDiffStats (90,000 git ops/hour) ⚡ **HIGHEST IMPACT**

**Problem:** Fetches diff stats for ALL 50 workspaces every 2s = 1,500 git operations/minute

**Location:** `src/app/layouts/MainLayout.tsx:86`

**Fix:**
```typescript
// REMOVE THIS LINE:
const diffStatsQuery = useBulkDiffStats(workspacesQuery.data || []);

// REMOVE THIS useEffect (lines ~300-305):
useEffect(() => {
  if (diffStatsQuery.data) {
    setMultipleDiffStats(diffStatsQuery.data);
  }
}, [diffStatsQuery.data, setMultipleDiffStats]);

// ADD: Only fetch for selected workspace
const selectedWorkspaceDiffStats = useDiffStats(selectedWorkspace?.id);

useEffect(() => {
  if (selectedWorkspace && selectedWorkspaceDiffStats.data) {
    setDiffStats(selectedWorkspace.id, selectedWorkspaceDiffStats.data);
  }
}, [selectedWorkspace, selectedWorkspaceDiffStats.data, setDiffStats]);
```

**Impact:** 90,000 git operations/hour → 0
**Time:** 5 minutes
**Difficulty:** Easy

---

### 2. Fix React Query Config ⚡ **EASY WIN**

**Problem:** Aggressive defaults cause cascade refetches

**Location:** `src/shared/api/queryClient.ts`

**Fix:**
```typescript
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 minutes (was 1s)
      gcTime: 10 * 60 * 1000,   // 10 minutes
      retry: 2,
      refetchOnWindowFocus: false, // Disable (was true)
      refetchOnMount: 'stale',     // Only if stale (was true)
      refetchInterval: false,       // No default polling
    },
  },
});
```

**Impact:** Eliminates cascade refetches when switching tabs
**Time:** 2 minutes
**Difficulty:** Trivial

---

### 3. Fix Port Discovery ⚡ **STARTUP SPEED**

**Problem:** Scans 30+ ports on every page load (0.5-2s delay)

**Location:** `src/shared/config/api.config.ts:19-28`

**Fix Option A (Quick):**
```typescript
// Reduce port list to recent ones only
const DISCOVERY_PORTS = [
  51176, 52820, 53792, // Recent successful ports
  50000, 51000, 52000, // Common ranges (3 instead of 30)
];
```

**Fix Option B (Better):**
```typescript
// Use Tauri to get port from backend
const port = await invoke('get_backend_port');
```

**Impact:** 30 failed requests → 3-5, startup time: 2s → 0.3s
**Time:** 5-10 minutes
**Difficulty:** Easy

---

## 🔥 PRIORITY 2: HIGH IMPACT (Next 1 hour)

### 4. Disable Workspace Polling

**Problem:** Still polling workspaces/stats/repos every 2s

**Locations:**
- `src/features/workspace/api/workspace.queries.ts`
- `src/features/repository/api/repository.queries.ts`

**Fix:**
```typescript
export function useWorkspacesByRepo(state: string = 'ready') {
  return useQuery({
    queryKey: queryKeys.workspaces.byRepo(state),
    queryFn: () => WorkspaceService.fetchByRepo(state),
    refetchInterval: false, // Disable polling
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

export function useStats() {
  return useQuery({
    queryKey: queryKeys.stats.all,
    queryFn: () => RepoService.fetchStats(),
    refetchInterval: false,
    staleTime: 5 * 60 * 1000,
  });
}

// Add invalidation to mutations
export function useCreateWorkspace() {
  return useMutation({
    mutationFn: (repositoryId: string) => WorkspaceService.create(repositoryId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.stats.all });
    },
  });
}
```

**Impact:** 60+ API calls/min → 0
**Time:** 15 minutes
**Difficulty:** Medium

---

### 5. Add Message Virtualization

**Problem:** Renders ALL 100+ messages in DOM

**Location:** `src/features/session/ui/Chat.tsx`

**Fix:**
```bash
npm install @tanstack/react-virtual
```

```typescript
import { useVirtualizer } from '@tanstack/react-virtual';

const rowVirtualizer = useVirtualizer({
  count: renderableMessages.length,
  getScrollElement: () => messagesContainerRef.current,
  estimateSize: () => 120, // Average message height
  overscan: 5,
});

{rowVirtualizer.getVirtualItems().map((virtualRow) => (
  <div
    key={virtualRow.index}
    style={{
      position: 'absolute',
      top: 0,
      left: 0,
      width: '100%',
      transform: `translateY(${virtualRow.start}px)`,
    }}
  >
    <MessageItem message={renderableMessages[virtualRow.index]} />
  </div>
))}
```

**Impact:** 1000+ DOM nodes → 20-30, smooth 60fps scrolling
**Time:** 30 minutes
**Difficulty:** Medium

---

## 🎯 PRIORITY 3: NICE TO HAVE (Next 2 hours)

### 6. Refactor MainLayout

**Problem:** God component with 8+ queries, 600+ lines

**Fix:** Split into smaller components
- `<WorkspaceList />`
- `<WorkspaceActions />`
- `<WorkspaceModals />`

**Impact:** Better maintainability, fewer re-renders
**Time:** 1-2 hours
**Difficulty:** High

---

### 7. Memoize Expensive Components

**Locations:** MessageItem, BlockRenderer, ToolRenderers

**Fix:**
```typescript
export const MessageItem = memo(({ message }) => {
  // ... component
}, (prevProps, nextProps) => {
  return prevProps.message.id === nextProps.message.id &&
         prevProps.message.content === nextProps.message.content;
});
```

**Impact:** Prevents unnecessary re-renders
**Time:** 30 minutes
**Difficulty:** Easy

---

## 📊 EXPECTED RESULTS

### After Priority 1 (30 min):
- Git operations: 90,000/hour → 0 (100% ↓)
- Startup time: 2s → 0.3s (85% ↓)
- API calls: Still ~100/min → ~20/min (80% ↓)
- **Website should be usable!**

### After Priority 2 (1.5 hours):
- API calls: 20/min → <5/min (95% ↓)
- Scrolling: Laggy → Smooth 60fps
- Memory: 100MB → 40MB (60% ↓)
- **Website should be fast!**

### After Priority 3 (3.5 hours):
- Maintainability: Poor → Good
- Re-renders: Many → Few
- Overall: Professional-grade performance

---

## 🚀 START HERE

**Do these 3 fixes RIGHT NOW (15 minutes total):**

1. **Kill useBulkDiffStats** - Remove from MainLayout.tsx
2. **Fix queryClient.ts** - Update staleTime and refetchOnWindowFocus
3. **Reduce port discovery** - Keep only 5 ports

**These 3 alone will make the website usable.**

---

## 🔧 QUICK CHECKLIST

- [ ] Remove useBulkDiffStats (5 min)
- [ ] Fix queryClient config (2 min)
- [ ] Reduce port scan (5 min)
- [ ] Disable workspace polling (15 min)
- [ ] Add message virtualization (30 min)
- [ ] Test: Website should be fast now!

---

## 📝 TESTING

After each fix, check:
```bash
# Open http://localhost:1420
# Open DevTools Network tab
# Count requests per minute
# Check: Should see <10 requests/min
```

**Goal:** <10 API calls/min, <500ms page load, smooth scrolling

---

**START WITH PRIORITY 1 NOW!** 🔥
