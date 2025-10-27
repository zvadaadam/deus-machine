# Chat Interface Redesign: Scannable Action Timeline

## Design Philosophy

**Mental Model:** Claude is a coworker showing you their work. Each tool call is a moment in Claude's work that should be instantly readable, answering: "What did Claude do, and what was the impact?"

## Core Principles

1. **Instant Scannability** - User should understand what happened in 5 seconds
2. **Visual Language** - Icons + verbs + previews = self-explanatory actions
3. **Progressive Disclosure** - More detail only when needed
4. **Semantic Weight** - Important content (final summary) stands out, transitional content recedes

## Tool Call Card Anatomy

### Level 1: Inline Preview (Default State)

Every tool renders as a single-line preview card:

```
[📄] Read auth.ts • 45 lines
[✏️] Edit login.tsx • +12 -3
[🧠] Thinking • "First I need to check..."
[⚙️] Run npm test • ✓ 4 passed
```

**Design Specs:**
- Height: ~32px with padding
- Background: transparent or bg-muted/10
- Border: 1px border-border/20
- Border-left: 2px colored (semantic)
- Icon: 16px, left side
- Text: 13px medium
- Preview: 12px regular, text-muted-foreground
- Padding: 6px 12px
- Hover: bg-muted/20
- Cursor: pointer

### Level 2: Compact Expanded (On Click)

Shows content preview (max 200px, then scroll or "show more")

### Level 3: Fully Expanded

Full content, no truncation

## Tool-Specific Preview Rules

### Read Tool
```
Icon: FileText (lucide-react)
Verb: "Read"
Preview: "{filename} • {lineCount} lines" OR "{filename} • Lines {start}-{end}"
Border: primary (blue)
```

### Edit/MultiEdit Tool
```
Icon: Pencil (lucide-react)
Verb: "Edit"
Preview: "{filename} • +{additions} -{deletions}"
Border: success (green)
```

### Bash Tool
```
Icon: Terminal (lucide-react)
Verb: "Run"
Preview: "{command} • {✓/✗} {exitCode}"
Border: warning (amber)
```

### Grep/Glob Tool
```
Icon: Search (lucide-react)
Verb: "Search"
Preview: "{pattern} • {resultCount} matches"
Border: primary (blue)
```

### TodoWrite Tool
```
Icon: CheckSquare (lucide-react)
Verb: "Updated todos"
Preview: "{completedCount}/{totalCount} complete • Working on: {currentTodo}"
Border: primary (blue)
```

### Thinking Tool
```
Icon: Brain (lucide-react)
Verb: "Thinking"
Preview: First sentence (max 60 chars) + "..."
Border: purple
Special: Distinct color to show it's mental process, not action
```

### Task/Agent Tool
```
Icon: Bot (lucide-react)
Verb: "Started agent"
Preview: "{agentType} • {status}"
Border: primary (blue)
```

### Unknown/MCP Tools
```
Icon: Wrench (lucide-react)
Verb: Tool name
Preview: "View details →"
Border: muted
```

## Text Block Visual Weight

### Muted Text (Between Tools)
```
Purpose: Transitional commentary
Font size: 13px
Line height: 1.5
Color: text-muted-foreground
Opacity: 0.7
Padding: 4px 0
```

### Hero Text (Final Summary)
```
Purpose: Conclusion/explanation
Font size: 16px
Line height: 1.7
Color: text-foreground
Padding: 16px 0
Border-top: 1px border-border/20
Margin-top: 12px
```

## Turn Structure

### Latest Turn (Active)
```
┌─────────────────────────────────────────────────────┐
│ Assistant                                           │
│                                                     │
│ [📄] Read auth.ts • 45 lines                       │ ← Tool previews
│ [📄] Read login.tsx • 67 lines                     │
│ [🧠] Thinking • "First I need to check the..."    │
│                                                     │
│ Let me update the authentication flow...           │ ← Muted text
│                                                     │
│ [✏️] Edit auth.ts • +23 -5                         │
│ [⚙️] Run npm test • ✓ 4 passed                     │
│                                                     │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│                                                     │
│ I've successfully updated the authentication       │ ← Hero summary
│ flow to use OAuth 2.0. All tests are passing.     │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### Previous Turn (Collapsed Default)
```
┌─────────────────────────────────────────────────────┐
│ Assistant • 5 actions ▾                            │
│                                                     │
│ I've successfully updated the authentication       │ ← Only summary
│ flow to use OAuth 2.0. All tests are passing.     │
│                                                     │
└─────────────────────────────────────────────────────┘
```

## Implementation Components

### 1. ToolPreview Component
Single-line preview card that expands on click

### 2. Tool Preview Data Interface
```typescript
interface ToolPreviewData {
  icon: React.ComponentType;
  verb: string;
  preview: string;
  stats?: string;
  borderColor: 'primary' | 'warning' | 'success' | 'muted' | 'purple';
}
```

### 3. TextBlock with Weight Variants
Renders text with appropriate visual weight based on semantic position

### 4. AssistantTurn Rebuilt
- No more "Read 3 files" summary header
- Shows tool previews in chronological order
- Muted transitional text
- Hero final summary
- Collapsible for previous turns (shows only summary + action count)

## Design Tokens

```css
/* Tool Preview */
--tool-preview-height: 32px;
--tool-preview-padding: 6px 12px;
--tool-preview-border-radius: 6px;
--tool-preview-icon-size: 16px;

/* Border Colors */
--tool-border-read: oklch(0.59 0.24 264) / 0.3;      /* primary/30% */
--tool-border-write: oklch(0.65 0.20 145) / 0.3;     /* success/30% */
--tool-border-execute: oklch(0.75 0.15 70) / 0.3;    /* warning/30% */
--tool-border-think: oklch(0.60 0.25 300) / 0.3;     /* purple/30% */
--tool-border-default: var(--border) / 0.2;

/* Text Weights */
--text-muted-size: 13px;
--text-normal-size: 15px;
--text-hero-size: 16px;
--text-hero-padding: 16px 0;
```

## Success Criteria

✅ **5-second scan test:** User can scan a turn in 5 seconds and know what happened
✅ **No mental translation:** Icons + verbs + previews are self-explanatory
✅ **Progressive disclosure:** User gets more detail only when needed
✅ **Visual rhythm:** Eye moves smoothly from tools → text → summary
✅ **Feels alive:** Animations and interactions feel responsive and intentional

## Animation Specs

- Tool preview hover: 150ms cubic-bezier(0.23, 1, 0.32, 1)
- Expand/collapse: 200ms cubic-bezier(0.23, 1, 0.32, 1)
- Smooth height transitions with `transition: all 200ms ease-out`
