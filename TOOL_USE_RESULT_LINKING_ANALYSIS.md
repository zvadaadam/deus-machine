# Tool Use → Tool Result Linking: Critical Architectural Analysis

**Date**: 2025-10-20
**Severity**: 🔴 CRITICAL - Requires Architecture Change

---

## 🎯 The Problem

The user identified a **fundamental architectural issue**: **tool_use** and **tool_result** are stored in SEPARATE MESSAGES, but our current refactor does NOT link them together.

---

## 📊 Current Message Structure (From Database)

### Example Sequence:

```json
// Message 4: tool_use (assistant message)
{
  "id": "f94a4466-9861-4710-8797-003224f5a146",
  "role": "assistant",
  "content": {
    "message": {
      "content": [
        {
          "type": "tool_use",
          "id": "toolu_01YNNnBp4cyyxRL3hdiY3X8R",  // ← The link key
          "name": "Bash",
          "input": { "command": "git branch -m ..." }
        }
      ]
    }
  }
}

// Message 9: tool_result (separate assistant message!)
{
  "id": "84273799-048f-42f6-92b2-b62f058874e3",
  "role": "assistant",
  "content": {
    "message": {
      "content": [
        {
          "type": "tool_result",
          "tool_use_id": "toolu_01YNNnBp4cyyxRL3hdiY3X8R",  // ← References tool_use.id
          "content": "",
          "is_error": false
        }
      ]
    }
  }
}
```

### Key Observations:

1. ✅ **Separate Messages**: `tool_use` and `tool_result` are in different messages
2. ✅ **Linking Field**: `tool_result.tool_use_id` references `tool_use.id`
3. ✅ **Batching**: Multiple tool_use messages can come first, results later
4. ✅ **Out of Order**: Results don't always come in the same order as calls
5. ❌ **No Built-in Link**: Our app doesn't build this link during rendering

---

## 🔍 Current Implementation (Broken)

### How We Currently Render:

```typescript
// MessageItem.tsx (Current)
contentBlocks.map((block, index) => (
  <BlockRenderer key={index} block={block} index={index} />
))
```

### What BlockRenderer Does:

```typescript
// BlockRenderer.tsx (Current)
switch (block.type) {
  case 'tool_use':
    return <ToolUseBlock block={block} />;  // ❌ No tool_result passed!

  case 'tool_result':
    return <ToolResultBlock block={block} />;  // ❌ Rendered separately!
}
```

### What Tool Renderers Expect:

```typescript
// EditToolRenderer.tsx signature
export function EditToolRenderer({
  toolUse,    // ✅ We have this
  toolResult  // ❌ We DON'T have this!
}: ToolRendererProps)
```

### **The Mismatch:**

- **Tool renderers EXPECT** both `toolUse` and `toolResult`
- **We currently ONLY pass** `toolUse`
- **tool_result blocks** are rendered separately as standalone "Result" boxes
- **They are NEVER linked** together

---

## 💥 Impact on UI

### What We Built (Phase 1-3):

```
▼ 📝 Edit File                      ✓ Applied    ← Expects toolResult
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📁 /foo/bar.ts

┌─────────────────┬──────────────────┐
│ − Before [📋]   │ + After [📋]     │
└─────────────────┴──────────────────┘
```

### What Actually Happens:

```
▼ 📝 Edit File                      ❓ No status!    ← toolResult is undefined
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📁 /foo/bar.ts
```

Then separately:

```
✅ Result
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
(empty content)
```

---

## 🔎 How OpenDevs Handled This

After deep exploration of OpenDevs codebase:

### Finding:
OpenDevs **did NOT have custom tool renderers** like we do.

```
# From CONDUCTOR_ARCHITECTURE.md:
"No Message Parsing"
- Frontend displays raw SDK output
- No tool-specific UI components
- No syntax highlighting
```

**Why it worked for OpenDevs:**
- They just displayed tool_use and tool_result as separate blocks
- No smart linking needed because no custom renderers
- Very basic UI: just JSON dumps

**Why it DOESN'T work for us:**
- We built beautiful custom renderers (Edit, Write, Bash, Read, Grep)
- These renderers NEED the result to show status (✓ Applied / ✗ Failed)
- Our UX depends on linking them together

---

## ✅ The Solution

We need to **build an index/mapping** that links `tool_use` → `tool_result` BEFORE rendering.

### Approach 1: Message-Level Mapping (Recommended)

Build the mapping in the `Chat` component or `useMessages` hook:

```typescript
// In useMessages.ts or Chat.tsx
function buildToolMap(messages: Message[]) {
  const toolMap = new Map<string, ToolResultBlock>();

  // First pass: collect all tool_results
  messages.forEach(message => {
    const blocks = parseContent(message.content);
    blocks.forEach(block => {
      if (block.type === 'tool_result') {
        toolMap.set(block.tool_use_id, block);
      }
    });
  });

  return toolMap;
}

// Usage
const toolMap = buildToolMap(messages);

// When rendering:
contentBlocks.forEach(block => {
  if (block.type === 'tool_use') {
    const toolResult = toolMap.get(block.id);
    return <ToolUseBlock block={block} toolResult={toolResult} />;
  }
  // Don't render tool_result blocks separately!
  if (block.type === 'tool_result') {
    return null;  // Skip - already linked to tool_use
  }
});
```

### Approach 2: Context Provider

```typescript
// ToolResultContext.tsx
const ToolResultContext = createContext<Map<string, ToolResultBlock>>(new Map());

export function ToolResultProvider({ messages, children }) {
  const toolMap = useMemo(() => buildToolMap(messages), [messages]);
  return (
    <ToolResultContext.Provider value={toolMap}>
      {children}
    </ToolResultContext.Provider>
  );
}

// In ToolUseBlock.tsx
const toolMap = useContext(ToolResultContext);
const toolResult = toolMap.get(block.id);
```

### Approach 3: Smart BlockRenderer

```typescript
// BlockRenderer.tsx - Enhanced
export function BlockRenderer({
  block,
  allBlocks,  // ← Pass all blocks from message
  toolResultMap  // ← Pass pre-built map
}: BlockRendererProps) {

  if (block.type === 'tool_use') {
    const toolResult = toolResultMap.get(block.id);
    return <ToolUseBlock block={block} toolResult={toolResult} />;
  }

  // Don't render standalone tool_result
  if (block.type === 'tool_result') {
    return null;
  }

  // ... other types
}
```

---

## 🎯 Recommended Implementation

**Approach 1** is cleanest and most explicit:

### Step 1: Update `useMessages` Hook

```typescript
// Add to useMessages.ts
const [toolResultMap, setToolResultMap] = useState<Map<string, ToolResultBlock>>(new Map());

useEffect(() => {
  const map = new Map<string, ToolResultBlock>();

  messages.forEach(message => {
    const blocks = parseContent(message.content);
    if (Array.isArray(blocks)) {
      blocks.forEach(block => {
        if (block.type === 'tool_result') {
          map.set(block.tool_use_id, block);
        }
      });
    }
  });

  setToolResultMap(map);
}, [messages, parseContent]);

// Return toolResultMap
return {
  // ... existing returns
  toolResultMap,
};
```

### Step 2: Update `Chat` Component

```typescript
// Chat.tsx
<MessageItem
  message={message}
  parseContent={parseContent}
  toolResultMap={toolResultMap}  // ← Pass the map
/>
```

### Step 3: Update `MessageItem`

```typescript
// MessageItem.tsx
export function MessageItem({ message, parseContent, toolResultMap }: MessageItemProps) {
  const contentBlocks = parseContent(message.content);

  return (
    <div>
      {contentBlocks.map((block, index) => (
        <BlockRenderer
          key={index}
          block={block}
          index={index}
          toolResultMap={toolResultMap}  // ← Pass down
        />
      ))}
    </div>
  );
}
```

### Step 4: Update `BlockRenderer`

```typescript
// BlockRenderer.tsx
export function BlockRenderer({ block, toolResultMap }: BlockRendererProps) {
  switch (block.type) {
    case 'tool_use':
      const toolResult = toolResultMap?.get(block.id);
      return <ToolUseBlock block={block} toolResult={toolResult} />;

    case 'tool_result':
      // Don't render - already linked to tool_use
      return null;

    // ... rest
  }
}
```

### Step 5: Update `ToolUseBlock`

```typescript
// ToolUseBlock.tsx
export function ToolUseBlock({ block, toolResult }: ToolUseBlockProps) {
  const ToolRenderer = toolRegistry.getRenderer(block.name);

  return (
    <div className="my-1">
      <ToolRenderer
        toolUse={block}
        toolResult={toolResult}  // ← Now available!
      />
    </div>
  );
}
```

---

## 📝 Testing Plan

1. **Verify Linking**: Check that Edit tool shows "✓ Applied" / "✗ Failed"
2. **Out of Order**: Test with tool results arriving in different order
3. **Missing Results**: Handle tool_use without tool_result (pending execution)
4. **Multiple Tools**: Test batch tool calls (multiple tool_use before results)
5. **Error Cases**: Verify error display works with is_error flag

---

## 🚨 Breaking Changes

1. **`BlockRenderer`** - Now needs `toolResultMap` prop
2. **`ToolUseBlock`** - Now receives `toolResult` prop
3. **`tool_result` blocks** - No longer rendered standalone
4. **All tool renderers** - Now correctly receive `toolResult`

---

## 📊 Impact Assessment

### Files to Modify:
1. `/src/hooks/useMessages.ts` - Build toolResultMap
2. `/src/features/workspace/components/Chat.tsx` - Pass toolResultMap
3. `/src/features/workspace/components/MessageItem.tsx` - Accept & pass toolResultMap
4. `/src/features/workspace/components/chat/blocks/BlockRenderer.tsx` - Handle linking
5. `/src/features/workspace/components/chat/blocks/ToolUseBlock.tsx` - Accept toolResult
6. `/src/features/workspace/components/chat/blocks/ToolResultBlock.tsx` - Delete or repurpose
7. `/src/features/workspace/components/chat/types.ts` - Update interfaces

### Estimated Effort:
- **Research**: ✅ Complete (this document)
- **Implementation**: 2-3 hours
- **Testing**: 1 hour
- **Total**: ~4 hours

---

## 🎯 Conclusion

This is a **critical architectural fix** that was missing from our refactor. The good news:

✅ **Our architecture supports it**: Registry pattern is flexible enough
✅ **Clean solution**: Map-based approach is simple and performant
✅ **Better UX**: Tool renderers will now show correct status
✅ **No data changes**: Backend/database structure is correct

The user was absolutely right to question this - it's a fundamental piece we missed!

---

**Next Steps**: Implement the recommended approach and test thoroughly.
