# Diff Stats - The SMART Solution

**Date:** 2025-10-26
**Problem:** Lazy loading breaks real-time updates for active workspaces

---

## 🧠 THE REALIZATION

**You're absolutely right!** When Claude is actively working on a workspace:
- Files are being edited in real-time
- Diff stats change as lines are added/removed
- User NEEDS to see badges update live: "+5" → "+12" → "+25"
- Lazy loading without polling = **stale data!**

---

## 📊 CURRENT BEHAVIOR ANALYSIS

### useBulkDiffStats (Current - Wasteful)
```typescript
// Polls EVERYTHING every 2s
const diffStatsQuery = useBulkDiffStats(workspacesQuery.data);

// Result with 50 workspaces:
// - 45 idle workspaces: Wasted 90% of polls
// - 5 working workspaces: Actually need updates
// Total: 50 workspaces × 30 polls/min = 1,500 polls/min
```

### useFileChanges (Current - Also Problematic)
```typescript
// Lines 126-136 in workspace.queries.ts
export function useFileChanges(workspaceId: string | null) {
  return useQuery({
    queryKey: queryKeys.workspaces.diffFiles(workspaceId || ''),
    queryFn: async () => {
      const result = await WorkspaceService.fetchDiffFiles(workspaceId!);
      return result.files || [];
    },
    enabled: !!workspaceId,
    staleTime: 5000, // ⚠️ No active polling!
    // Missing: refetchInterval based on session status
  });
}
```

**Problem:** FileChangesPanel shows list of files, but **doesn't actively poll**. It relies on:
- Component re-renders (indirect)
- staleTime expiring (5s lag)
- Manual refresh

**So file changes ALSO have stale data issues!**

---

## 💡 THE SMART SOLUTION: Conditional Polling

**Concept:** Poll ONLY workspaces that are actively working

### Option A: Status-Based Polling (Best Balance) ⭐

**Implementation:**

```typescript
// src/features/workspace/api/workspace.queries.ts

export function useDiffStats(
  workspaceId: string | null,
  sessionStatus?: 'idle' | 'working' | 'compacting' | null
) {
  return useQuery({
    queryKey: queryKeys.workspaces.diffStats(workspaceId || ''),
    queryFn: () => WorkspaceService.fetchDiffStats(workspaceId!),
    enabled: !!workspaceId,
    staleTime: 30000, // 30 seconds for idle workspaces

    // ✅ Poll ONLY when workspace is actively working
    refetchInterval: (query) => {
      if (sessionStatus === 'working') {
        return 5000; // Poll every 5s when Claude is working
      }
      return false; // No polling when idle
    },
  });
}

export function useFileChanges(
  workspaceId: string | null,
  sessionStatus?: 'idle' | 'working' | 'compacting' | null
) {
  return useQuery({
    queryKey: queryKeys.workspaces.diffFiles(workspaceId || ''),
    queryFn: async () => {
      const result = await WorkspaceService.fetchDiffFiles(workspaceId!);
      return result.files || [];
    },
    enabled: !!workspaceId,
    staleTime: 30000,

    // ✅ Poll ONLY when workspace is actively working
    refetchInterval: (query) => {
      if (sessionStatus === 'working') {
        return 5000; // Poll every 5s when Claude is working
      }
      return false; // No polling when idle
    },
  });
}
```

**Usage in RepositoryItem:**

```typescript
function RepositoryItem({ repository, ... }) {
  return (
    <>
      {repository.workspaces.map((workspace) => {
        // Fetch diff stats with conditional polling
        const { data: diffStats } = useDiffStats(
          workspace.id,
          workspace.session_status // ✅ Pass status
        );

        return (
          <WorkspaceItem
            workspace={workspace}
            diffStats={diffStats}
            {...props}
          />
        );
      })}
    </>
  );
}
```

**Usage in FileChangesPanel:**

```typescript
export function FileChangesPanel({ selectedWorkspace }: FileChangesPanelProps) {
  // ✅ Pass session status for conditional polling
  const { data: fileChanges = [] } = useFileChanges(
    selectedWorkspace?.id || null,
    selectedWorkspace?.session_status
  );

  const { data: devServers = [] } = useDevServers(
    selectedWorkspace?.id || null
  );

  // ... rest
}
```

---

## 📊 EXPECTED PERFORMANCE

### Scenario 1: User has 50 workspaces, 5 are working

**Current (useBulkDiffStats):**
- Polls all 50 workspaces every 2s
- 50 × 30 polls/min = **1,500 polls/min**
- 90,000 git operations/hour

**Smart Solution:**
- Polls only 5 working workspaces every 5s
- 5 × 12 polls/min = **60 polls/min**
- 3,600 git operations/hour

**Improvement:** 96% reduction! (1,500 → 60 polls/min)

---

### Scenario 2: User has 50 workspaces, all idle

**Current:**
- Still polls all 50 every 2s
- **1,500 polls/min**

**Smart Solution:**
- Polls 0 workspaces
- **0 polls/min**

**Improvement:** 100% reduction!

---

### Scenario 3: User has 50 workspaces, 1 working, 1 selected

**Current:**
- Polls all 50 every 2s
- **1,500 polls/min**

**Smart Solution:**
- Polls 1 working workspace (sidebar badge)
- Polls 1 selected workspace (FileChangesPanel)
- 2 × 12 polls/min = **24 polls/min**

**Improvement:** 98.4% reduction!

---

## 🎯 COMPARISON TABLE

| Architecture | All Idle | 5 Working | 1 Working + Selected | Complexity |
|--------------|----------|-----------|---------------------|------------|
| **Current (Bulk)** | 1,500/min | 1,500/min | 1,500/min | Low |
| **Lazy Load (No Poll)** | 0/min | 0/min ⚠️ | 0/min ⚠️ | Low |
| **Smart Conditional** | 0/min | 60/min ✅ | 24/min ✅ | Medium |
| **Event-Based** | 0/min | 0/min ✅ | 0/min ✅ | High |

⚠️ = Stale data for working workspaces
✅ = Real-time updates

---

## 💡 EVEN BETTER: Event-Based Updates (Option B)

**Concept:** Emit events when Claude edits files, invalidate queries

**Backend:**
```javascript
// backend/lib/claude-session.cjs

function handleClaudeMessage(sessionId, message) {
  // Existing: Save message
  db.prepare(`INSERT INTO session_messages ...`).run(...);

  // ✅ NEW: Emit event to sidecar
  if (message.type === 'assistant' && hasToolUseBlocks(message)) {
    // Claude used Edit/Write tools
    const sidecar = getSidecarManager();
    sidecar.send({
      type: 'frontend_event',
      event: 'workspace:files-changed',
      payload: {
        session_id: sessionId,
        workspace_id: getWorkspaceId(sessionId),
      }
    });
  }
}
```

**Frontend:**
```typescript
// src/features/workspace/hooks/useWorkspaceEvents.ts (NEW)

export function useWorkspaceEvents(workspaceId: string | null) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!workspaceId || !isTauriEnv) return;

    const unlisten = listen('workspace:files-changed', (event) => {
      if (event.payload.workspace_id === workspaceId) {
        // Invalidate diff stats and file changes
        queryClient.invalidateQueries({
          queryKey: queryKeys.workspaces.diffStats(workspaceId),
        });
        queryClient.invalidateQueries({
          queryKey: queryKeys.workspaces.diffFiles(workspaceId),
        });
      }
    });

    return () => {
      unlisten.then(fn => fn());
    };
  }, [workspaceId]);
}
```

**Usage:**
```typescript
function RepositoryItem({ repository }) {
  return repository.workspaces.map(workspace => {
    // Listen for file change events
    useWorkspaceEvents(workspace.id);

    const { data: diffStats } = useDiffStats(workspace.id);

    return <WorkspaceItem workspace={workspace} diffStats={diffStats} />;
  });
}
```

**Benefits:**
- **Zero polling** (even for working workspaces)
- **Instant updates** when Claude edits files
- **Scales to unlimited workspaces**

**Downsides:**
- More complex (needs event detection in backend)
- Only works in Tauri mode (web mode needs fallback)

---

## 🚀 RECOMMENDED IMPLEMENTATION PLAN

### Phase 1: Smart Conditional Polling (30 minutes) ⭐ DO THIS

**Step 1:** Update `useDiffStats` (10 min)

```typescript
// src/features/workspace/api/workspace.queries.ts

export function useDiffStats(
  workspaceId: string | null,
  sessionStatus?: string | null
) {
  return useQuery({
    queryKey: queryKeys.workspaces.diffStats(workspaceId || ''),
    queryFn: () => WorkspaceService.fetchDiffStats(workspaceId!),
    enabled: !!workspaceId,
    staleTime: 30000,
    refetchInterval: sessionStatus === 'working' ? 5000 : false,
  });
}
```

**Step 2:** Update `useFileChanges` (5 min)

```typescript
export function useFileChanges(
  workspaceId: string | null,
  sessionStatus?: string | null
) {
  return useQuery({
    queryKey: queryKeys.workspaces.diffFiles(workspaceId || ''),
    queryFn: async () => {
      const result = await WorkspaceService.fetchDiffFiles(workspaceId!);
      return result.files || [];
    },
    enabled: !!workspaceId,
    staleTime: 30000,
    refetchInterval: sessionStatus === 'working' ? 5000 : false,
  });
}
```

**Step 3:** Update RepositoryItem (10 min)

```typescript
// src/features/sidebar/ui/RepositoryItem.tsx

{repository.workspaces.map((workspace) => {
  const { data: diffStats } = useDiffStats(
    workspace.id,
    workspace.session_status // ✅ Pass status
  );

  return (
    <WorkspaceItem
      key={workspace.id}
      workspace={workspace}
      diffStats={diffStats}
      // ... props
    />
  );
})}
```

**Step 4:** Update FileChangesPanel (5 min)

```typescript
// src/features/workspace/ui/FileChangesPanel.tsx

const { data: fileChanges = [] } = useFileChanges(
  selectedWorkspace?.id || null,
  selectedWorkspace?.session_status // ✅ Pass status
);
```

**Step 5:** Remove useBulkDiffStats from MainLayout (5 min)

```typescript
// src/app/layouts/MainLayout.tsx

// DELETE:
const diffStatsQuery = useBulkDiffStats(workspacesQuery.data || []);

// DELETE:
useEffect(() => {
  if (diffStatsQuery.data) {
    setMultipleDiffStats(diffStatsQuery.data);
  }
}, [diffStatsQuery.data, setMultipleDiffStats]);
```

---

### Phase 2: Event-Based Updates (Later - 1 hour)

Add event emission when Claude edits files (Option B above).

---

## ✅ SUCCESS CRITERIA

### Performance Metrics

| Scenario | Current | Phase 1 | Phase 2 |
|----------|---------|---------|---------|
| **50 workspaces, all idle** | 1,500/min | 0/min | 0/min |
| **5 working workspaces** | 1,500/min | 60/min | 0/min |
| **1 working + 1 selected** | 1,500/min | 24/min | 0/min |

### User Experience

- [ ] Badges show on page load (within 1s)
- [ ] Badges update in real-time when Claude is working (5s latency)
- [ ] Badges don't flicker or load progressively
- [ ] File changes panel updates when Claude edits files
- [ ] No lag when scrolling sidebar
- [ ] Network tab shows minimal requests

---

## 🎉 SUMMARY

**Your question exposed the flaw in my lazy-loading solution!**

**The Real Requirements:**
1. ✅ Show diff stats badges on all workspaces
2. ✅ Update badges in real-time for working workspaces
3. ✅ Don't waste resources on idle workspaces
4. ✅ Update file changes panel for selected workspace

**The Smart Solution:**
- **Phase 1:** Poll ONLY workspaces that are working (96-100% reduction)
- **Phase 2:** Event-based updates for zero polling (99.9% reduction)

**Time to implement Phase 1:** 30 minutes
**Complexity:** Medium (but worth it!)

**This gives you:**
- Real-time updates for active workspaces ✅
- Zero waste on idle workspaces ✅
- Clean architecture ✅

**Ready to implement?**
