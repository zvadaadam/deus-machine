# Chat Architecture Refactor Proposal

## 🎯 Executive Summary

Based on deep analysis of the original Conductor project and modern best practices, this document proposes a **comprehensive refactor** of our chat implementation to be:

- **✨ Extensible** - Easy to add new tool types
- **🧹 Maintainable** - Clean, modular code
- **🚀 Performant** - Optimized rendering
- **🎨 Beautiful** - Consistent design system
- **📦 Type-Safe** - Full TypeScript coverage

---

## 📊 Current State Analysis

### Current Implementation

```
src/features/workspace/components/
├── Chat.tsx (93 lines)              # Container + scroll logic
├── MessageItem.tsx (114 lines)      # MONOLITHIC renderer
├── MessageInput.tsx (184 lines)     # Input + actions
└── FileChangesPanel.tsx             # File sidebar
```

### Problems Identified

#### 1. **Monolithic MessageItem**
```typescript
// Current: All rendering logic in one component
function MessageItem({ message }) {
  function renderToolUse(toolUse) { /* 15 lines */ }
  function renderToolResult(result) { /* 20 lines */ }
  function renderText(text) { /* 6 lines */ }

  // 40 lines of rendering logic
  return (
    <div>
      {blocks.map(block => {
        if (block.type === 'tool_use') return renderToolUse(block);
        if (block.type === 'tool_result') return renderToolResult(block);
        // ... more conditionals
      })}
    </div>
  );
}
```

**Issues:**
- ❌ Hard to extend (add new tool → edit core file)
- ❌ No tool-specific customization
- ❌ Mixed concerns (styling + logic + rendering)
- ❌ Poor type safety (`any` types)
- ❌ No component reusability

#### 2. **No Tool Registry**
```typescript
// Current: Hardcoded tool types
if (block.name === 'Edit') { /* render Edit */ }
if (block.name === 'Write') { /* render Write */ }
if (block.name === 'Bash') { /* render Bash */ }
// Want to add new tool? Edit this file!
```

#### 3. **Inline Styles & Colors**
```typescript
// Current: Hardcoded colors everywhere
className="bg-sidebar-accent/30 border-l-primary"
className="bg-destructive/10 text-destructive"
className="bg-success/10 text-success-foreground"
```

#### 4. **Limited Tool Rendering**
- No syntax highlighting
- No collapsible outputs
- No copy buttons
- No line numbers
- No diff view for file changes

---

## 🏗️ Proposed Architecture

### 1. **Component Hierarchy**

```
src/features/workspace/components/chat/
│
├── index.ts                          # Public exports
│
├── Chat.tsx                          # Main container
├── MessageList.tsx                   # Scrollable area
├── EmptyState.tsx                    # No messages view
├── ScrollButton.tsx                  # Scroll to bottom
│
├── message/
│   ├── MessageItem.tsx               # Wrapper (role, timestamp)
│   ├── MessageHeader.tsx             # Role + time display
│   ├── MessageContent.tsx            # Content blocks container
│   └── MessageAvatar.tsx             # User/Assistant avatar
│
├── blocks/                           # Content block renderers
│   ├── BlockRenderer.tsx             # Smart dispatcher
│   ├── TextBlock.tsx                 # Plain text
│   ├── ToolUseBlock.tsx              # Tool invocation
│   ├── ToolResultBlock.tsx           # Tool result
│   ├── ThinkingBlock.tsx             # Thinking display
│   ├── ImageBlock.tsx                # Image content
│   └── index.ts
│
├── tools/                            # Tool-specific renderers
│   ├── ToolRegistry.tsx              # Registry + factory
│   ├── BaseToolRenderer.tsx          # Base component
│   │
│   ├── renderers/
│   │   ├── EditToolRenderer.tsx      # Edit tool UI
│   │   ├── WriteToolRenderer.tsx     # Write tool UI
│   │   ├── BashToolRenderer.tsx      # Bash tool UI
│   │   ├── ReadToolRenderer.tsx      # Read tool UI
│   │   ├── GrepToolRenderer.tsx      # Grep tool UI
│   │   ├── GlobToolRenderer.tsx      # Glob tool UI
│   │   └── DefaultToolRenderer.tsx   # Fallback
│   │
│   ├── components/                   # Shared tool components
│   │   ├── CodeBlock.tsx             # Syntax highlighted code
│   │   ├── DiffView.tsx              # Before/after diff
│   │   ├── JsonViewer.tsx            # Collapsible JSON
│   │   ├── TerminalOutput.tsx        # Terminal-style output
│   │   ├── FilePathDisplay.tsx       # File path with icon
│   │   └── CopyButton.tsx            # Copy to clipboard
│   │
│   └── index.ts
│
├── input/
│   ├── MessageInput.tsx              # Main input container
│   ├── InputField.tsx                # Textarea component
│   ├── InputActions.tsx              # Action buttons
│   └── index.ts
│
├── theme/
│   ├── chatTheme.ts                  # Theme tokens
│   ├── animations.ts                 # Animation configs
│   └── index.ts
│
└── hooks/
    ├── useMessageGrouping.ts         # Group related messages
    ├── useToolPairing.ts             # Pair tool_use + tool_result
    └── index.ts
```

---

## 🎨 Design System

### Theme Tokens

```typescript
// theme/chatTheme.ts
export const chatTheme = {
  message: {
    user: {
      container: 'ml-auto bg-primary/10 border border-primary/30',
      text: 'text-foreground',
      maxWidth: 'max-w-[85%]',
    },
    assistant: {
      container: 'mr-auto bg-sidebar-accent/40 border border-border/40',
      text: 'text-foreground',
      maxWidth: 'max-w-[85%]',
    },
  },

  blocks: {
    tool: {
      container: 'bg-sidebar-accent/30 rounded-md border border-border/40',
      header: 'flex items-center gap-1.5 mb-1.5 font-semibold text-xs',
      content: 'p-2 rounded font-mono text-xs',
      borderLeft: {
        default: 'border-l-2 border-l-primary',
        success: 'border-l-2 border-l-success',
        error: 'border-l-2 border-l-destructive',
      },
    },

    code: {
      container: 'relative group',
      pre: 'bg-sidebar-accent/40 p-3 rounded overflow-x-auto',
      lineNumbers: 'text-muted-foreground select-none',
    },

    diff: {
      added: 'bg-success/10 text-success-foreground border-l-2 border-l-success',
      removed: 'bg-destructive/10 text-destructive-foreground border-l-2 border-l-destructive',
    },
  },

  animations: {
    messageEnter: {
      initial: { opacity: 0, y: 10 },
      animate: { opacity: 1, y: 0 },
      transition: { duration: 0.2, ease: [0.215, 0.61, 0.355, 1] }, // ease-out-cubic
    },
    toolExpand: {
      initial: { height: 0, opacity: 0 },
      animate: { height: 'auto', opacity: 1 },
      transition: { duration: 0.3, ease: [0.215, 0.61, 0.355, 1] },
    },
  },
} as const;
```

### Color System

```typescript
// Use Tailwind theme colors consistently
const colorTokens = {
  success: 'hsl(var(--success))',
  error: 'hsl(var(--destructive))',
  info: 'hsl(var(--info))',
  warning: 'hsl(var(--warning))',
  primary: 'hsl(var(--primary))',
  muted: 'hsl(var(--muted))',
};

// Never hardcode colors like:
// ❌ '#10b981'
// ❌ 'rgb(16, 185, 129)'
// ✅ 'text-success'
// ✅ 'bg-success/10'
```

---

## 🔧 Core Components

### 1. Block Renderer (Smart Dispatcher)

```typescript
// blocks/BlockRenderer.tsx
import { TextBlock } from './TextBlock';
import { ToolUseBlock } from './ToolUseBlock';
import { ToolResultBlock } from './ToolResultBlock';
import { ThinkingBlock } from './ThinkingBlock';
import type { ContentBlock } from '@/types';

interface BlockRendererProps {
  block: ContentBlock;
  index: number;
}

export function BlockRenderer({ block, index }: BlockRendererProps) {
  // Smart dispatch based on block type
  switch (block.type) {
    case 'text':
      return <TextBlock key={index} block={block} />;

    case 'tool_use':
      return <ToolUseBlock key={index} block={block} />;

    case 'tool_result':
      return <ToolResultBlock key={index} block={block} />;

    case 'thinking':
      return <ThinkingBlock key={index} block={block} />;

    default:
      // Graceful fallback for unknown types
      if (import.meta.env.DEV) {
        console.warn('Unknown block type:', (block as any).type);
      }
      return null;
  }
}
```

### 2. Tool Registry Pattern

```typescript
// tools/ToolRegistry.tsx
import type { ToolUseBlock, ToolResultBlock } from '@/types';

export interface ToolRendererProps {
  toolUse: ToolUseBlock;
  toolResult?: ToolResultBlock;
}

export type ToolRenderer = React.ComponentType<ToolRendererProps>;

class ToolRendererRegistry {
  private renderers = new Map<string, ToolRenderer>();
  private defaultRenderer: ToolRenderer;

  constructor() {
    // Set default fallback
    this.defaultRenderer = DefaultToolRenderer;
  }

  /**
   * Register a tool renderer
   */
  register(toolName: string, renderer: ToolRenderer): void {
    this.renderers.set(toolName, renderer);
    console.log(`[ToolRegistry] Registered renderer for: ${toolName}`);
  }

  /**
   * Get renderer for tool (returns default if not found)
   */
  getRenderer(toolName: string): ToolRenderer {
    return this.renderers.get(toolName) || this.defaultRenderer;
  }

  /**
   * Check if tool has custom renderer
   */
  hasRenderer(toolName: string): boolean {
    return this.renderers.has(toolName);
  }

  /**
   * Get all registered tool names
   */
  getRegisteredTools(): string[] {
    return Array.from(this.renderers.keys());
  }
}

// Singleton instance
export const toolRegistry = new ToolRendererRegistry();

// Auto-register all built-in tools
import { EditToolRenderer } from './renderers/EditToolRenderer';
import { WriteToolRenderer } from './renderers/WriteToolRenderer';
import { BashToolRenderer } from './renderers/BashToolRenderer';
import { ReadToolRenderer } from './renderers/ReadToolRenderer';
import { GrepToolRenderer } from './renderers/GrepToolRenderer';
import { DefaultToolRenderer } from './renderers/DefaultToolRenderer';

toolRegistry.register('Edit', EditToolRenderer);
toolRegistry.register('Write', WriteToolRenderer);
toolRegistry.register('Bash', BashToolRenderer);
toolRegistry.register('Read', ReadToolRenderer);
toolRegistry.register('Grep', GrepToolRenderer);

// Easy to add new tools:
// toolRegistry.register('NewTool', NewToolRenderer);
```

### 3. Tool Use Block (Uses Registry)

```typescript
// blocks/ToolUseBlock.tsx
import { toolRegistry } from '../tools/ToolRegistry';
import { chatTheme } from '../theme';
import type { ToolUseBlock as ToolUseBlockType } from '@/types';

interface ToolUseBlockProps {
  block: ToolUseBlockType;
}

export function ToolUseBlock({ block }: ToolUseBlockProps) {
  // Get appropriate renderer from registry
  const ToolRenderer = toolRegistry.getRenderer(block.name);

  return (
    <div className={chatTheme.blocks.tool.container}>
      <ToolRenderer toolUse={block} />
    </div>
  );
}
```

### 4. Edit Tool Renderer Example

```typescript
// tools/renderers/EditToolRenderer.tsx
import { useState } from 'react';
import { ChevronDown, ChevronRight, FileEdit } from 'lucide-react';
import { CodeBlock } from '../components/CodeBlock';
import { DiffView } from '../components/DiffView';
import { FilePathDisplay } from '../components/FilePathDisplay';
import { CopyButton } from '../components/CopyButton';
import { chatTheme } from '../../theme';
import type { ToolRendererProps } from '../ToolRegistry';

export function EditToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  const { file_path, old_string, new_string } = toolUse.input;
  const isError = toolResult?.is_error;

  return (
    <div className="space-y-2">
      {/* Header */}
      <div
        className="flex items-center justify-between cursor-pointer hover:bg-muted/50 p-2 rounded"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-2">
          {isExpanded ? (
            <ChevronDown className="w-4 h-4" aria-hidden="true" />
          ) : (
            <ChevronRight className="w-4 h-4" aria-hidden="true" />
          )}
          <FileEdit className="w-4 h-4 text-info" aria-hidden="true" />
          <span className="font-semibold text-sm">Edit File</span>
        </div>

        <div className="flex items-center gap-2">
          {toolResult && (
            <span className={isError ? 'text-destructive' : 'text-success'}>
              {isError ? '✗' : '✓'}
            </span>
          )}
          <CopyButton
            text={old_string}
            label="Copy old"
          />
          <CopyButton
            text={new_string}
            label="Copy new"
          />
        </div>
      </div>

      {/* File path */}
      <FilePathDisplay path={file_path} />

      {/* Collapsible content */}
      {isExpanded && (
        <div className="space-y-2">
          <DiffView
            before={old_string}
            after={new_string}
            language={getLanguageFromPath(file_path)}
          />

          {/* Error display */}
          {isError && toolResult && (
            <div className="p-3 rounded bg-destructive/10 border border-destructive/30">
              <p className="text-sm text-destructive-foreground font-mono">
                {toolResult.content}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function getLanguageFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase();
  const languageMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    py: 'python',
    rs: 'rust',
    // ... more mappings
  };
  return languageMap[ext || ''] || 'plaintext';
}
```

### 5. Shared Components

#### Code Block with Syntax Highlighting

```typescript
// tools/components/CodeBlock.tsx
import { useState } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { CopyButton } from './CopyButton';

interface CodeBlockProps {
  code: string;
  language?: string;
  showLineNumbers?: boolean;
  maxHeight?: string;
}

export function CodeBlock({
  code,
  language = 'typescript',
  showLineNumbers = true,
  maxHeight = '400px'
}: CodeBlockProps) {
  return (
    <div className="relative group">
      {/* Copy button (appears on hover) */}
      <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
        <CopyButton text={code} />
      </div>

      {/* Syntax highlighted code */}
      <SyntaxHighlighter
        language={language}
        style={oneDark}
        showLineNumbers={showLineNumbers}
        customStyle={{
          margin: 0,
          borderRadius: '0.375rem',
          fontSize: '0.875rem',
          maxHeight,
        }}
        codeTagProps={{
          style: {
            fontFamily: 'var(--font-mono)',
          }
        }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}
```

#### Diff Viewer

```typescript
// tools/components/DiffView.tsx
import { diffLines } from 'diff';
import { CodeBlock } from './CodeBlock';

interface DiffViewProps {
  before: string;
  after: string;
  language?: string;
}

export function DiffView({ before, after, language }: DiffViewProps) {
  const diff = diffLines(before, after);

  return (
    <div className="grid grid-cols-2 gap-1 bg-border/40 p-px rounded overflow-hidden">
      {/* Before */}
      <div className="bg-background">
        <div className="px-3 py-2 bg-destructive/10 text-destructive font-semibold text-sm border-b border-border/40">
          − Before
        </div>
        <div className="p-3 max-h-[300px] overflow-y-auto font-mono text-xs">
          {diff.filter(part => !part.added).map((part, i) => (
            <div
              key={i}
              className={part.removed ? 'bg-destructive/20' : ''}
            >
              {part.value}
            </div>
          ))}
        </div>
      </div>

      {/* After */}
      <div className="bg-background">
        <div className="px-3 py-2 bg-success/10 text-success font-semibold text-sm border-b border-border/40">
          + After
        </div>
        <div className="p-3 max-h-[300px] overflow-y-auto font-mono text-xs">
          {diff.filter(part => !part.removed).map((part, i) => (
            <div
              key={i}
              className={part.added ? 'bg-success/20' : ''}
            >
              {part.value}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
```

#### Copy Button

```typescript
// tools/components/CopyButton.tsx
import { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface CopyButtonProps {
  text: string;
  label?: string;
}

export function CopyButton({ text, label = 'Copy' }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation(); // Don't trigger parent clicks
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleCopy}
      className="h-6 px-2 text-xs"
      title={label}
    >
      {copied ? (
        <>
          <Check className="w-3 h-3 mr-1" aria-hidden="true" />
          Copied
        </>
      ) : (
        <>
          <Copy className="w-3 h-3 mr-1" aria-hidden="true" />
          {label}
        </>
      )}
    </Button>
  );
}
```

---

## 🚀 Migration Strategy

### Phase 1: Foundation (Week 1)
- [ ] Create new folder structure
- [ ] Set up theme system
- [ ] Create base components
- [ ] Implement BlockRenderer
- [ ] Add tool registry

### Phase 2: Tool Renderers (Week 2)
- [ ] Build shared components (CodeBlock, DiffView, etc.)
- [ ] Implement Edit tool renderer
- [ ] Implement Write tool renderer
- [ ] Implement Bash tool renderer
- [ ] Implement Read tool renderer

### Phase 3: Integration (Week 3)
- [ ] Update MessageItem to use new system
- [ ] Migrate existing components
- [ ] Add tests
- [ ] Performance optimization
- [ ] Documentation

### Phase 4: Enhancements (Week 4)
- [ ] Add collapsible outputs
- [ ] Implement message grouping
- [ ] Add copy buttons everywhere
- [ ] Syntax highlighting polish
- [ ] Animation polish

---

## 📦 Dependencies to Add

```json
{
  "dependencies": {
    "react-syntax-highlighter": "^15.5.0",
    "diff": "^5.1.0",
    "framer-motion": "^10.16.4"
  },
  "devDependencies": {
    "@types/react-syntax-highlighter": "^15.5.11",
    "@types/diff": "^5.0.8"
  }
}
```

---

## 🎯 Benefits

### Extensibility
✅ Add new tool renderer → just create component + register
✅ No need to edit core files
✅ Plugin-like architecture

### Maintainability
✅ Small, focused components (~50-100 lines each)
✅ Clear separation of concerns
✅ Easy to test
✅ Easy to understand

### Performance
✅ Better memoization opportunities
✅ Lazy loading possible
✅ Reduced re-renders

### Developer Experience
✅ TypeScript everywhere
✅ Auto-completion works
✅ Clear interfaces
✅ Self-documenting code

### User Experience
✅ Syntax highlighting
✅ Collapsible outputs
✅ Copy buttons
✅ Diff views
✅ Smooth animations

---

## 🎨 Visual Examples

### Before (Current)
```
┌─────────────────────────────────────┐
│ 🔧 Edit                             │
│ {                                   │
│   "file_path": "/foo/bar.ts",       │
│   "old_string": "...",              │
│   "new_string": "..."               │
│ }                                   │
└─────────────────────────────────────┘
```

### After (Proposed)
```
┌─────────────────────────────────────┐
│ ▼ 📝 Edit File              ✓ [📋] │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │
│ 📁 /foo/bar.ts                      │
│ ┌──────────────┬─────────────────┐  │
│ │ − Before     │ + After         │  │
│ ├──────────────┼─────────────────┤  │
│ │ const x = 1; │ const x = 2;    │  │
│ │              │ console.log(x); │  │
│ └──────────────┴─────────────────┘  │
└─────────────────────────────────────┘
```

---

## 📚 Example Usage

### Adding a New Tool Renderer

```typescript
// 1. Create renderer component
// tools/renderers/MyNewToolRenderer.tsx
export function MyNewToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  return (
    <div className="space-y-2">
      <h4>My New Tool</h4>
      <CodeBlock code={JSON.stringify(toolUse.input, null, 2)} />
    </div>
  );
}

// 2. Register it
// tools/ToolRegistry.tsx
import { MyNewToolRenderer } from './renderers/MyNewToolRenderer';
toolRegistry.register('MyNewTool', MyNewToolRenderer);

// 3. Done! It now works automatically
```

### Custom Theme

```typescript
// Override theme for specific component
import { chatTheme } from '../theme';

const customTheme = {
  ...chatTheme,
  blocks: {
    ...chatTheme.blocks,
    tool: {
      ...chatTheme.blocks.tool,
      container: 'bg-purple-500/10 border-purple-500/30', // Custom color
    },
  },
};
```

---

## 🔍 Testing Strategy

```typescript
// MessageItem.test.tsx
describe('MessageItem', () => {
  it('renders text blocks', () => {
    const message = {
      id: '1',
      role: 'assistant',
      content: JSON.stringify([
        { type: 'text', text: 'Hello' }
      ])
    };

    render(<MessageItem message={message} />);
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  it('uses registry for tool rendering', () => {
    const message = {
      id: '1',
      role: 'assistant',
      content: JSON.stringify([
        { type: 'tool_use', name: 'Edit', input: {} }
      ])
    };

    render(<MessageItem message={message} />);
    expect(toolRegistry.getRenderer).toHaveBeenCalledWith('Edit');
  });
});

// ToolRegistry.test.tsx
describe('ToolRegistry', () => {
  it('returns default renderer for unknown tools', () => {
    const renderer = toolRegistry.getRenderer('UnknownTool');
    expect(renderer).toBe(DefaultToolRenderer);
  });

  it('registers and retrieves custom renderers', () => {
    const CustomRenderer = () => <div>Custom</div>;
    toolRegistry.register('CustomTool', CustomRenderer);

    const renderer = toolRegistry.getRenderer('CustomTool');
    expect(renderer).toBe(CustomRenderer);
  });
});
```

---

## 🎯 Success Metrics

After refactor, we should achieve:

- ✅ **Code Quality**: Component size <150 lines
- ✅ **Type Coverage**: 100% TypeScript coverage
- ✅ **Performance**: <16ms render time per message
- ✅ **Extensibility**: Add new tool in <30 min
- ✅ **Maintainability**: New dev onboarding <2 hours
- ✅ **Test Coverage**: >80% coverage

---

## 🚀 Next Steps

1. **Review & Approve** - Team review this proposal
2. **Spike** - Build small proof-of-concept
3. **Iterate** - Refine based on feedback
4. **Implement** - Follow migration strategy
5. **Test** - Comprehensive testing
6. **Deploy** - Gradual rollout

---

## 📖 Further Reading

- [React Component Patterns](https://kentcdodds.com/blog/compound-components-with-react-hooks)
- [Plugin Architecture](https://addyosmani.com/resources/essentialjsdesignpatterns/book/)
- [Design Systems](https://www.designsystems.com/)
- [Tailwind Best Practices](https://tailwindcss.com/docs/reusing-styles)
