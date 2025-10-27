# Task: Add File Status Indicators to File Changes Panel

## Context
The FileChangesPanel currently shows file paths with +/- stats, but doesn't indicate if a file is New, Modified, or Deleted.

## Current State
- Location: `src/features/workspace/ui/FileChangesPanel.tsx`
- Data structure: `FileChange` interface in `src/features/workspace/types.ts` (lines 56-61)
- Current fields: `file`, `additions`, `deletions`

## Goal
Add visual indicators for file status:
- **New file** (N) - green badge
- **Modified** (M) - blue/yellow badge
- **Deleted** (D) - red badge

## Implementation Requirements

### 1. Backend Investigation
First, check if the backend API already provides status:
- Check `WorkspaceService.fetchFileChanges()` response
- Check backend endpoint that provides file changes
- If status exists, update `FileChange` interface to include it

### 2. Status Inference (if backend doesn't provide)
If backend doesn't provide status explicitly, infer from additions/deletions:
```typescript
function getFileStatus(additions: number, deletions: number): 'new' | 'modified' | 'deleted' {
  if (deletions === 0 && additions > 0) return 'new';
  if (additions === 0 && deletions > 0) return 'deleted';
  return 'modified';
}
```

**Note:** This inference isn't 100% reliable (a file with only additions might still be modified), but it's reasonable.

### 3. UI Design
Add small badge before the filename:
```tsx
<span className="text-[10px] font-medium px-1 py-0.5 rounded mr-1.5">
  {status === 'new' && <span className="text-success bg-success/10">N</span>}
  {status === 'modified' && <span className="text-primary bg-primary/10">M</span>}
  {status === 'deleted' && <span className="text-destructive bg-destructive/10">D</span>}
</span>
```

### 4. Reference
Look at how sidebar `WorkspaceItem.tsx` displays status badges (lines 176-188) for consistent styling.

## Files to Modify
1. `src/features/workspace/types.ts` - Add `status?` field to `FileChange` interface
2. `src/features/workspace/ui/FileChangesPanel.tsx` - Add status badge rendering
3. `src/features/workspace/api/workspace.service.ts` - Check if backend provides status

## Testing
- Verify status shows correctly for new files (only additions)
- Verify status shows correctly for deleted files (only deletions)
- Verify status shows correctly for modified files (both additions and deletions)
- Ensure styling is consistent with the rest of the UI
