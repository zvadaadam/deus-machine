import type { Meta, StoryObj } from "@storybook/react-vite";
import { SyntaxHighlighter } from "./SyntaxHighlighter";
import { CodeBlock } from "./CodeBlock";
import { ChatMarkdown } from "@/components/markdown/ChatMarkdown";

// ── SyntaxHighlighter (Tool Output) ────────────────────────────────

const meta: Meta<typeof SyntaxHighlighter> = {
  title: "Chat/SyntaxHighlighter",
  component: SyntaxHighlighter,
  parameters: { layout: "padded" },
};
export default meta;

// TypeScript
export const TypeScript: StoryObj<typeof SyntaxHighlighter> = {
  args: {
    language: "typescript",
    code: `import { useState, useEffect } from "react";

interface User {
  id: string;
  name: string;
  email: string;
  role: "admin" | "user" | "guest";
}

export function useUser(userId: string) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    fetch(\`/api/users/\${userId}\`)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setUser(data);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [userId]);

  return { user, loading };
}`,
  },
};

// With Line Numbers
export const WithLineNumbers: StoryObj<typeof SyntaxHighlighter> = {
  args: {
    language: "typescript",
    showLineNumbers: true,
    code: `export async function highlightCode(
  code: string,
  language: string,
  theme: "github-dark" | "github-light" = "github-dark"
): Promise<string> {
  const highlighter = await getHighlighter();
  const lang = await ensureLanguage(highlighter, language);
  return highlighter.codeToHtml(code, { lang, theme });
}`,
  },
};

// Python
export const Python: StoryObj<typeof SyntaxHighlighter> = {
  args: {
    language: "python",
    code: `from dataclasses import dataclass
from typing import Optional

@dataclass
class Config:
    host: str = "localhost"
    port: int = 8080
    debug: bool = False
    secret: Optional[str] = None

def create_app(config: Config) -> "App":
    """Initialize application with given config."""
    app = App(config)
    app.setup_routes()
    if config.debug:
        app.enable_logging()
    return app`,
  },
};

// Rust
export const Rust: StoryObj<typeof SyntaxHighlighter> = {
  args: {
    language: "rust",
    code: `use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct Cache<T: Clone> {
    store: HashMap<String, T>,
    capacity: usize,
}

impl<T: Clone> Cache<T> {
    pub fn new(capacity: usize) -> Self {
        Self {
            store: HashMap::with_capacity(capacity),
            capacity,
        }
    }

    pub fn get(&self, key: &str) -> Option<&T> {
        self.store.get(key)
    }

    pub fn insert(&mut self, key: String, value: T) {
        if self.store.len() >= self.capacity {
            // Evict oldest entry (simplified)
            if let Some(first_key) = self.store.keys().next().cloned() {
                self.store.remove(&first_key);
            }
        }
        self.store.insert(key, value);
    }
}`,
  },
};

// JSON
export const JSON: StoryObj<typeof SyntaxHighlighter> = {
  args: {
    language: "json",
    code: `{
  "name": "opendevs-ide",
  "version": "1.0.0",
  "dependencies": {
    "react": "^19.1.0",
    "shiki": "^3.22.0",
    "@tanstack/react-query": "^5.90.5"
  },
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "test": "vitest"
  }
}`,
  },
};

// CSS
export const CSS: StoryObj<typeof SyntaxHighlighter> = {
  args: {
    language: "css",
    code: `.markdown-content pre {
  margin-top: 0.75rem;
  margin-bottom: 0.75rem;
  padding: 0.5rem 0.75rem;
  overflow-x: auto;
  border-radius: 0.375rem;
  background-color: var(--bg-code);
  font-family: var(--font-family-mono);
  font-size: 0.75rem;
  line-height: 1.5;
}

@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}`,
  },
};

// SQL
export const SQL: StoryObj<typeof SyntaxHighlighter> = {
  args: {
    language: "sql",
    code: `CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  status TEXT DEFAULT 'idle',
  agent_type TEXT DEFAULT 'claude',
  title TEXT,
  last_user_message_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_workspace_id
  ON sessions(workspace_id);

SELECT s.id, s.status, s.title, w.name as workspace_name
FROM sessions s
JOIN workspaces w ON s.workspace_id = w.id
WHERE s.status = 'working'
ORDER BY s.updated_at DESC
LIMIT 10;`,
  },
};

// Bash
export const Bash: StoryObj<typeof SyntaxHighlighter> = {
  args: {
    language: "bash",
    code: `#!/bin/bash
set -euo pipefail

# Build sidecar and start dev server
echo "Building sidecar..."
bun run build:sidecar

echo "Starting dev server..."
export DATABASE_PATH="$HOME/Library/Application Support/com.opendevs.app/opendevs.db"
bun run dev:web &
DEV_PID=$!

trap "kill $DEV_PID 2>/dev/null" EXIT
wait $DEV_PID`,
  },
};

// ── CodeBlock (Tool Renderer Wrapper) ──────────────────────────────

export const CodeBlockWithCopy: StoryObj<typeof CodeBlock> = {
  render: (args) => (
    <div style={{ maxWidth: 600 }}>
      <CodeBlock {...args} />
    </div>
  ),
  args: {
    language: "typescript",
    code: `export function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}`,
  },
};

export const CodeBlockWithLineNumbers: StoryObj<typeof CodeBlock> = {
  render: (args) => (
    <div style={{ maxWidth: 600 }}>
      <CodeBlock {...args} />
    </div>
  ),
  args: {
    language: "typescript",
    showLineNumbers: true,
    code: `import { createHighlighter } from "shiki";

const highlighter = await createHighlighter({
  themes: ["github-dark", "github-light"],
  langs: ["typescript", "javascript", "python"],
});

const html = highlighter.codeToHtml(code, {
  lang: "typescript",
  theme: "github-dark",
});`,
  },
};

// ── Chat Markdown (Progressive Shiki) ──────────────────────────────

export const ChatCodeBlock: StoryObj<typeof ChatMarkdown> = {
  render: (args) => (
    <div style={{ maxWidth: 700 }}>
      <ChatMarkdown {...args}>{args.children}</ChatMarkdown>
    </div>
  ),
  args: {
    children: `Here's a React hook for debouncing:

\`\`\`typescript
import { useState, useEffect } from "react";

export function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debouncedValue;
}
\`\`\`

Use it like \`const debouncedSearch = useDebounce(query, 300)\`.`,
  },
};

export const ChatMultipleLanguages: StoryObj<typeof ChatMarkdown> = {
  render: (args) => (
    <div style={{ maxWidth: 700 }}>
      <ChatMarkdown {...args}>{args.children}</ChatMarkdown>
    </div>
  ),
  args: {
    children: `Here are examples in different languages:

**TypeScript:**
\`\`\`typescript
const greeting: string = "Hello, World!";
console.log(greeting);
\`\`\`

**Python:**
\`\`\`python
def fibonacci(n: int) -> int:
    if n <= 1:
        return n
    return fibonacci(n - 1) + fibonacci(n - 2)

print(fibonacci(10))  # 55
\`\`\`

**Rust:**
\`\`\`rust
fn main() {
    let numbers: Vec<i32> = (1..=10).collect();
    let sum: i32 = numbers.iter().sum();
    println!("Sum: {}", sum);
}
\`\`\`

**SQL:**
\`\`\`sql
SELECT u.name, COUNT(o.id) as order_count
FROM users u
LEFT JOIN orders o ON u.id = o.user_id
GROUP BY u.id
HAVING order_count > 5
ORDER BY order_count DESC;
\`\`\`

Each language gets proper syntax highlighting via Shiki.`,
  },
};

export const ChatInlineAndBlock: StoryObj<typeof ChatMarkdown> = {
  render: (args) => (
    <div style={{ maxWidth: 700 }}>
      <ChatMarkdown {...args}>{args.children}</ChatMarkdown>
    </div>
  ),
  args: {
    children: `You can use \`useState\` for local state and \`useEffect\` for side effects.

\`\`\`typescript
const [count, setCount] = useState(0);

useEffect(() => {
  document.title = \`Count: \${count}\`;
}, [count]);
\`\`\`

Note that \`useEffect\` runs after render. For synchronous DOM reads, use \`useLayoutEffect\` instead.`,
  },
};
