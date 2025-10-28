# Chat Interface Redesign: Scannable Action Timeline

## Design Philosophy (Jony Ive Principles)

**Mental Model:** Claude is a coworker showing you their work. Each tool call is a moment in Claude's work that should be instantly readable, answering: "What did Claude do, and what was the impact?"

**Core Philosophy:**
> "Simplicity is not the absence of clutter... it's about bringing order to complexity."
> — Jony Ive

We create clarity through **subtraction**, not addition. Every element must earn its place by serving the content.

## Core Principles

1. **Pure Content** - Remove all decoration. No backgrounds, no borders unless meaningful
2. **Semantic Color** - Color conveys meaning (green = added, red = removed/error), never decoration
3. **Assume Success** - Only show errors. Success is the default, silence is confirmation
4. **No Duplication** - Preview disappears when expanded. Don't repeat information
5. **Typography Hierarchy** - Weight, size, and opacity create structure, not boxes
6. **Inevitable Interaction** - Subtle, responsive, feels natural (opacity not backgrounds)

## Tool Call Card Anatomy

### Collapsed (Default State)

Every tool renders as a minimal single line:

```
> [📄] Read • auth.ts • 45 lines
> [✏️] Edit • login.tsx • +12 -3
> [🧠] Thinking • "I need to check the authentication flow and understand how the current..."
> [⚙️] Bash • Run tests
```

**Design Specs:**
- **Background:** Transparent (no decoration)
- **Border:** None (pure content)
- **Icon:** 16px, muted color (text-muted-foreground/70)
- **Chevron:** 12px, muted (text-muted-foreground/50), rotates on expand
- **Name:** 13px font-medium
- **Preview:** 12px, text-muted-foreground, monospace for paths
- **Status:** Only shown for errors (`✗ Error` in destructive red)
- **Padding:** 6px 8px (minimal)
- **Hover:** opacity-80 (200ms transition, subtle feedback)
- **Cursor:** pointer

**Color Rules:**
- Icon: Muted gray (text-muted-foreground/70) or error red for failures
- Preview text: text-muted-foreground
- File paths: font-mono (distinguishes paths from descriptions)
- Diff stats: Green (+12) and red (-3) for semantic meaning
- Error indicator: text-destructive

### Expanded (On Click)

Shows **only the content**, preview disappears (no duplication):

```
> [📄] Read • auth.ts • 45 lines

    [CODE BLOCK with syntax highlighting]
    import { OAuth } from './oauth';
    ...
```

**Content Display:**
- Indented 20px from left (ml-5)
- CodeBlock with syntax highlighting (for Read)
- Diff view with ± lines (for Edit)
- Command + output (for Bash: `$ command\n\noutput`)
- Full thinking text (for Thinking)
- Max height 400px with scroll for long content

## Tool-Specific Preview Rules

### Read Tool
```
Icon: FileText (text-muted-foreground/70)
Name: "Read"
Preview: "{filename} • {lineCount} lines" (font-mono)
Expanded: Full file content with syntax highlighting + line numbers
Error: Show error message in destructive color
```

**Example:**
- Collapsed: `> 📄 Read • auth.ts • 45 lines`
- Expanded: Shows CodeBlock with syntax highlighting, no repeated header

### Edit/MultiEdit Tool
```
Icon: Pencil (text-muted-foreground/70)
Name: "Edit"
Preview: "{filename} • +{added} -{removed}" (font-mono, colored stats)
Expanded: Diff view (before/after) with copy buttons
Error: Show error message in destructive color
```

**Example:**
- Collapsed: `> ✏️ Edit • login.tsx • +12 -3` (green/red numbers)
- Expanded: Shows before/after diff, no repeated header

### Bash Tool
```
Icon: Terminal (text-muted-foreground/70)
Name: "Bash"
Preview: {description} OR first 50 chars of {command}
Expanded: $ {command}\n\n{output}
Error: Output in destructive color with border
```

**Example:**
- Collapsed: `> ⚙️ Bash • Run tests` (uses description field)
- Expanded: Shows command + output, no repeated header

### Grep/Glob Tool
```
Icon: Search (text-muted-foreground/70)
Name: "Grep" or "Glob"
Preview: "{pattern}"
Expanded: Matching files/lines
```

### Thinking Tool
```
Icon: Brain (text-purple-600/70) — special color for reasoning
Name: "Thinking"
Preview: First 120 chars (width-based, not sentence-based)
Expanded: Full thinking text (preview disappears!)
```

**Example:**
- Collapsed: `> 🧠 Thinking • "I need to check the authentication flow and understand how the current session..."`
- Expanded: Shows full thinking text, preview is hidden (no duplication)

### Other Tools (TodoWrite, Task, WebFetch, etc.)
```
Icon: Appropriate icon (text-muted-foreground/70)
Name: Tool name
Preview: Contextual summary from tool input
Expanded: Tool-specific content
```

## Text Block Visual Weight

Text blocks use **typography hierarchy** (not boxes) to show importance.

### Muted Text (Transitional Commentary)
```
Purpose: Between-tool explanations ("Let me check the auth flow...")
Color: text-muted-foreground
Opacity: 0.7
Font size: 13px (prose-sm)
Line height: 1.5
Weight: 'muted' prop
```

**Why muted:** This text bridges actions but isn't the main message.

### Normal Text (Final Summary)
```
Purpose: Conclusion/explanation ("I've updated the authentication...")
Color: text-foreground (full brightness)
Opacity: 1.0
Font size: 15px (prose-base)
Line height: 1.7
Weight: 'normal' prop (default)
```

**Why normal:** This is the key takeaway — what Claude accomplished and why it matters.

**Implementation:** TextBlock component detects if it's the last text block in the message and applies the appropriate weight.

## Turn Structure (Pure Content)

All messages render as a clean, flat list — no cards, no wrapper decorations.

### Assistant Message Layout
```
> 📄 Read • auth.ts • 45 lines
> 📄 Read • login.tsx • 67 lines
> 🧠 Thinking • "I need to check the authentication flow..."

Let me update the authentication flow to use OAuth 2.0.

> ✏️ Edit • auth.ts • +23 -5
> ⚙️ Bash • Run tests

I've successfully updated the authentication flow. All tests are passing.
```

**Visual Hierarchy:**
1. Tool calls (collapsed): Single lines with chevron + icon + preview
2. Transitional text: Muted gray, smaller (13px)
3. Final summary: Full brightness, normal size (15px)

**Spacing:**
- Gap between blocks: 8px (gap-2)
- No card wrappers
- No background colors
- No borders (except for error states)

## Implementation Architecture

### Component Hierarchy
```
MessageItem.tsx
├─ User messages: BlockRenderer
└─ Assistant messages: BlockRenderer (same!)
    ├─ TextBlock (with weight: 'muted' | 'normal')
    ├─ ToolUseBlock → ToolRegistry → Specific Renderer
    │   └─ BaseToolRenderer (shared infrastructure)
    │       ├─ ReadToolRenderer (syntax highlighting)
    │       ├─ EditToolRenderer (diff view)
    │       ├─ BashToolRenderer (command + output)
    │       └─ 12+ other renderers
    └─ ThinkingBlock (special renderer for reasoning)
```

### Key Components

**1. BlockRenderer** (`src/features/session/ui/blocks/BlockRenderer.tsx`)
- Dispatches content blocks to appropriate renderers
- Routes `text` → TextBlock
- Routes `tool_use` → ToolUseBlock → toolRegistry
- Routes `thinking` → ThinkingBlock
- Links tool results via toolResultMap

**2. TextBlock** (`src/features/session/ui/blocks/TextBlock.tsx`)
- Renders markdown with ReactMarkdown
- Accepts `weight` prop: `'muted'` (transitional) or `'normal'` (final)
- Weight is auto-detected: last text block = normal, others = muted

**3. BaseToolRenderer** (`src/features/session/ui/tools/components/BaseToolRenderer.tsx`)
- Shared infrastructure for all tool renderers
- Provides: expand/collapse, status (error-only), consistent styling
- Uses render props API: `renderSummary`, `renderMetadata`, `renderContent`
- Change once → affects all 15 tools!

**4. Tool-Specific Renderers** (`src/features/session/ui/tools/renderers/*.tsx`)
- ReadToolRenderer: File content with syntax highlighting
- EditToolRenderer: Diff view (before/after)
- BashToolRenderer: Command + output
- 12+ more specialized renderers

**5. ThinkingBlock** (`src/features/session/ui/blocks/ThinkingBlock.tsx`)
- Special renderer for Claude's reasoning
- Width-based preview (120 chars)
- Preview hidden when expanded (no duplication)

**6. ToolRegistry** (`src/features/session/ui/tools/ToolRegistry.ts`)
- Maps tool names → renderers
- Auto-registers all tools on startup
- Fallback to DefaultToolRenderer for unknown tools

## Styling Guide

### Colors (Semantic Only)
```css
/* Icons */
--tool-icon-muted: text-muted-foreground/70  /* default tool icons */
--tool-icon-thinking: text-purple-600/70     /* special: thinking */
--tool-icon-error: text-destructive          /* errors only */

/* Text */
--preview-text: text-muted-foreground        /* previews, 12px */
--text-muted: text-muted-foreground          /* transitional, 13px, opacity-70 */
--text-normal: text-foreground               /* final summary, 15px */

/* Semantic colors (meaningful only) */
--diff-added: text-green-600                 /* +12 lines */
--diff-removed: text-red-600                 /* -3 lines */
--error: text-destructive                    /* ✗ Error */
```

### Spacing & Sizing
```css
--tool-icon-size: 16px
--chevron-size: 12px
--tool-padding: 6px 8px
--tool-gap: 8px (gap-2)
--content-indent: 20px (ml-5)
--content-max-height: 400px
```

### Interactions
```css
/* Hover: Subtle opacity change (not background) */
hover:opacity-80
transition-opacity duration-200

/* Expand/collapse: Smooth rotation */
transition-transform duration-200
rotate-90 (when expanded)
```

## Success Criteria

✅ **5-second scan:** Instantly understand what Claude did
✅ **No duplication:** Preview → expanded shows content only
✅ **Semantic color:** Green/red convey meaning, not decoration
✅ **Assume success:** Silence = success, only show errors
✅ **Pure content:** No backgrounds, no decorative borders
✅ **Consistent:** Change BaseToolRenderer once → affects all tools
