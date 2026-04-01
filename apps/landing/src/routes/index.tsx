import { createFileRoute } from '@tanstack/react-router'
import { useState, useRef, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import {
  ArrowRight,
  Download,
  Layers,
  GitBranch,
  Monitor,
  Bot,
  Zap,
  Wrench,
  Terminal,
  Apple,
  Globe,
  MessageSquare,
  Send,
} from 'lucide-react'

export const Route = createFileRoute('/')({ component: LandingPage })

const NAV_ITEMS = [
  { id: 'overview', label: 'Overview' },
  { id: 'install', label: 'Install' },
  { id: 'how-it-works', label: 'How it works' },
  { id: 'features', label: 'Features' },
  { id: 'architecture', label: 'Architecture' },
]

function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Mobile top bar */}
      <header className="sticky top-0 z-50 flex items-center justify-between bg-background/80 px-5 py-3 backdrop-blur-xl md:hidden">
        <a href="/" className="text-[13px] font-bold tracking-[-0.01em]">
          Deus Machine
        </a>
        <Button size="sm" asChild>
          <a href="https://app.deusmachine.ai">Open App</a>
        </Button>
      </header>

      <div className="mx-auto flex max-w-6xl">
        {/* Left sidebar */}
        <aside className="sticky top-0 hidden h-screen w-52 shrink-0 md:block">
          <div className="flex h-full flex-col px-5 py-8">
            <a href="/" className="mb-10 flex items-center gap-2.5">
              <div className="flex size-6 items-center justify-center rounded-[5px] bg-foreground">
                <span className="text-[10px] font-bold text-background">D</span>
              </div>
              <span className="text-[13px] font-bold tracking-[-0.01em]">
                Deus Machine
              </span>
            </a>
            <nav className="flex flex-col gap-0.5">
              {NAV_ITEMS.map((item) => (
                <a
                  key={item.id}
                  href={`#${item.id}`}
                  className="rounded-md px-2 py-1.5 text-[13px] text-muted-foreground transition-colors duration-150 hover:text-foreground"
                >
                  {item.label}
                </a>
              ))}
            </nav>
            <div className="mt-auto flex flex-col gap-1">
              <a
                href="https://github.com/zvadaadam/box-ide"
                target="_blank"
                rel="noopener noreferrer"
                className="px-2 py-1 text-[12px] text-muted-foreground/60 transition-colors duration-150 hover:text-foreground"
              >
                GitHub
              </a>
              <a
                href="https://app.deusmachine.ai"
                className="px-2 py-1 text-[12px] text-muted-foreground/60 transition-colors duration-150 hover:text-foreground"
              >
                Web App
              </a>
              <a
                href="mailto:hello@deusmachine.ai"
                className="px-2 py-1 text-[12px] text-muted-foreground/60 transition-colors duration-150 hover:text-foreground"
              >
                Contact
              </a>
            </div>
          </div>
        </aside>

        {/* Main content */}
        <main className="min-w-0 flex-1 px-6 py-12 md:px-14 md:py-20">
          <article className="mx-auto max-w-[640px]">
            <section id="overview" className="mb-20">
              <h1 className="text-4xl font-semibold tracking-[-0.03em] sm:text-5xl">
                Deus Machine
              </h1>
              <p className="mt-4 max-w-[58ch] text-base leading-[1.65] text-muted-foreground">
                A desktop IDE for running multiple AI coding agents in parallel.
                Point them at tasks, watch them work, review and merge.
              </p>
              <div className="mt-10 overflow-hidden rounded-xl ring-1 ring-inset ring-foreground/[0.07] shadow-[0_2px_4px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.08),0_24px_48px_rgba(0,0,0,0.06)]">
                <InteractiveDemo />
              </div>
              <p className="mt-3 text-center text-[11px] text-muted-foreground/40">
                Try it — click workspaces, toggle views, send a message
              </p>
            </section>

            <section id="install" className="mb-20">
              <h2 className="text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                Install
              </h2>
              <p className="mt-3 max-w-[58ch] text-sm leading-[1.7] text-muted-foreground">
                Deus Machine runs as a native desktop app on macOS. Download the
                latest release or build from source.
              </p>
              <div className="mt-6 flex flex-col gap-3 sm:flex-row">
                <Button size="lg" asChild>
                  <a href="https://github.com/zvadaadam/box-ide/releases">
                    <Apple className="mr-2 size-4" />
                    Download for macOS
                  </a>
                </Button>
                <Button variant="outline" size="lg" asChild>
                  <a
                    href="https://github.com/zvadaadam/box-ide"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    View source
                    <ArrowRight className="ml-2 size-4" />
                  </a>
                </Button>
              </div>
              <div className="mt-6 rounded-lg bg-[var(--code-surface)] p-4 ring-1 ring-inset ring-foreground/[0.06]">
                <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/60">
                  Build from source
                </p>
                <pre className="mt-2.5 overflow-x-auto text-[13px] leading-relaxed text-[var(--code-foreground)]">
                  <code>{`git clone https://github.com/zvadaadam/box-ide.git
cd box-ide
bun install
bun run dev`}</code>
                </pre>
              </div>
            </section>

            <section id="how-it-works" className="mb-20">
              <h2 className="text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                How it works
              </h2>
              <ol className="mt-5 space-y-5">
                {[
                  { title: 'Open a project.', text: 'Point Deus Machine at any git repository on your machine or clone from GitHub.' },
                  { title: 'Spin up workspaces.', text: "Each workspace creates an isolated git worktree. Run as many as you want — they don't interfere with each other." },
                  { title: 'Give agents instructions.', text: 'Type what you want — a bug fix, a new feature, a refactor. The agent takes it from there.' },
                  { title: 'Review and merge.', text: 'Watch agents work in real-time. See diffs, file changes, and terminal output. Create PRs when ready.' },
                ].map((step, i) => (
                  <li key={i} className="flex gap-3.5">
                    <span className="w-4 shrink-0 pt-px text-sm tabular-nums text-muted-foreground/40">{i + 1}.</span>
                    <span className="text-sm leading-[1.7] text-muted-foreground">
                      <strong className="font-medium text-foreground">{step.title}</strong>{' '}{step.text}
                    </span>
                  </li>
                ))}
              </ol>
            </section>

            <section id="features" className="mb-20">
              <h2 className="text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">Features</h2>
              <div className="mt-5 space-y-0.5">
                {FEATURES.map((f) => (
                  <div key={f.title} className="flex gap-4 py-3">
                    <f.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground/50" />
                    <div>
                      <p className="text-sm font-medium">{f.title}</p>
                      <p className="mt-0.5 text-sm leading-[1.7] text-muted-foreground">{f.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section id="architecture" className="mb-20">
              <h2 className="text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">Architecture</h2>
              <p className="mt-3 max-w-[58ch] text-sm leading-[1.7] text-muted-foreground">
                Electron app with a React frontend and Node.js backend. The agent-server runs as a separate process, wrapping Claude and Codex SDKs. All communication flows through WebSockets.
              </p>
              <div className="mt-5 rounded-lg bg-[var(--code-surface)] p-4 ring-1 ring-inset ring-foreground/[0.06]">
                <pre className="overflow-x-auto text-[12px] leading-[1.7] text-[var(--code-foreground)]">
                  <code>{`Frontend (React + Zustand + React Query)
  ├── WebSocket → Node.js Backend
  │     ├── Query Protocol (subscribe/snapshot/delta)
  │     ├── Commands (sendMessage, stopSession)
  │     └── Agent Client → Agent-Server (JSON-RPC 2.0)
  │           ├── Claude SDK
  │           └── Codex SDK
  ├── Electron IPC → Main Process
  │     ├── Git operations
  │     ├── Terminal / PTY sessions
  │     └── Process lifecycle
  └── SQLite Database (local, self-contained)`}</code>
                </pre>
              </div>
            </section>

            <footer className="flex items-center justify-between pt-8 text-[12px] text-muted-foreground/50">
              <span>Deus Machine</span>
              <a href="mailto:hello@deusmachine.ai" className="transition-colors duration-150 hover:text-foreground">
                hello@deusmachine.ai
              </a>
            </footer>
          </article>
        </main>
      </div>
    </div>
  )
}

const FEATURES = [
  { icon: Layers, title: 'Parallel agents', description: 'Run multiple AI coding agents simultaneously. Each agent works in its own workspace on its own task.' },
  { icon: GitBranch, title: 'Git worktrees', description: 'Every workspace gets an isolated git worktree. No conflicts between agents, clean branches, easy PRs.' },
  { icon: Monitor, title: 'Live preview', description: 'Watch agents work in real-time. See diffs, file changes, and terminal output as they happen.' },
  { icon: Bot, title: 'Claude & Codex', description: 'First-class support for Claude and Codex agents. Swap models, adjust thinking effort, use your own API keys.' },
  { icon: Zap, title: 'Browser automation', description: 'Agents can see and interact with browsers. Test UIs, capture screenshots, validate work visually.' },
  { icon: Wrench, title: 'MCP & tools', description: 'Extend agent capabilities with MCP servers, custom tools, and hooks. Configure per-workspace or globally.' },
  { icon: Terminal, title: 'Terminal access', description: 'Full terminal access per workspace. Agents run commands, install dependencies, and run tests.' },
  { icon: Download, title: 'Mobile access', description: 'Pair your phone to monitor and control agents from anywhere via the web app.' },
]

// --- Interactive Demo ---

interface Message {
  role: 'user' | 'assistant' | 'tool'
  content: string
  typing?: boolean
}

interface Workspace {
  id: string
  name: string
  repo: string
  status: 'active' | 'pending' | 'idle'
  time?: string
  messages: Message[]
  diff?: { file: string; add: number; del: number }
  browserUrl?: string
}

const WORKSPACES: Workspace[] = [
  {
    id: 'auth',
    name: 'feat/auth-flow',
    repo: 'box-ide',
    status: 'active',
    time: '2m',
    messages: [
      { role: 'user', content: 'Add error handling to the auth middleware' },
      { role: 'assistant', content: "I'll add try-catch blocks around the token verification and session validation. Let me also add proper error responses with status codes..." },
      { role: 'tool', content: 'Editing auth/middleware.ts' },
    ],
    diff: { file: 'auth/middleware.ts', add: 24, del: 3 },
  },
  {
    id: 'sidebar',
    name: 'fix/sidebar-bug',
    repo: 'box-ide',
    status: 'pending',
    messages: [
      { role: 'user', content: 'The sidebar collapses on hover instead of click' },
      { role: 'assistant', content: "Found it — the hover listener on SidebarTrigger is conflicting with the click handler. I'll remove the mouseenter event and keep only the button click..." },
      { role: 'tool', content: 'Editing sidebar/trigger.tsx' },
    ],
    diff: { file: 'sidebar/trigger.tsx', add: 8, del: 12 },
  },
  {
    id: 'refactor',
    name: 'refactor/api',
    repo: 'box-ide',
    status: 'idle',
    messages: [
      { role: 'user', content: 'Extract the query builder into a shared utility' },
      { role: 'assistant', content: "I've created a new QueryBuilder class in shared/lib/query-builder.ts. It handles parameter binding, pagination, and supports both SQLite and the test mock. Migrating the 4 route files now..." },
    ],
    diff: { file: 'shared/lib/query-builder.ts', add: 156, del: 0 },
  },
  {
    id: 'caching',
    name: 'add-caching',
    repo: 'api-server',
    status: 'active',
    messages: [
      { role: 'user', content: 'Add Redis caching for the /users endpoint' },
      { role: 'assistant', content: "I'll set up a cache-aside pattern with a 5-minute TTL. The cache key will include the query parameters so filtered requests get separate entries..." },
      { role: 'tool', content: 'Editing routes/users.ts' },
    ],
    diff: { file: 'routes/users.ts', add: 42, del: 5 },
    browserUrl: 'localhost:3001/users',
  },
  {
    id: 'perf',
    name: 'perf/queries',
    repo: 'api-server',
    status: 'idle',
    messages: [
      { role: 'user', content: 'Profile the slow dashboard query and optimize it' },
      { role: 'assistant', content: 'The main bottleneck is a missing index on sessions.workspace_id. After adding it, the query dropped from 340ms to 12ms. I also replaced the correlated subquery with a JOIN...' },
    ],
    diff: { file: 'services/dashboard.ts', add: 18, del: 31 },
  },
]

const AGENT_REPLIES: Record<string, string> = {
  default: "I'll look into that. Let me analyze the code and find the best approach...",
  fix: "Found the issue. Let me write a fix and run the tests to make sure nothing breaks...",
  add: "Good idea. I'll implement that feature. Starting with the type definitions, then the UI...",
  test: "I'll write tests for this. Setting up the test fixtures first, then covering the edge cases...",
  refactor: "I'll clean that up. Moving the shared logic into a utility module and updating all the import sites...",
}

function getAgentReply(input: string): string {
  const lower = input.toLowerCase()
  if (lower.includes('fix') || lower.includes('bug')) return AGENT_REPLIES.fix
  if (lower.includes('add') || lower.includes('create') || lower.includes('implement')) return AGENT_REPLIES.add
  if (lower.includes('test')) return AGENT_REPLIES.test
  if (lower.includes('refactor') || lower.includes('clean') || lower.includes('extract')) return AGENT_REPLIES.refactor
  return AGENT_REPLIES.default
}

function InteractiveDemo() {
  const [activeWs, setActiveWs] = useState('auth')
  const [view, setView] = useState<'chat' | 'browser'>('chat')
  const [extraMessages, setExtraMessages] = useState<Record<string, Message[]>>({})
  const [input, setInput] = useState('')
  const [isTyping, setIsTyping] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const workspace = WORKSPACES.find((w) => w.id === activeWs)!
  const allMessages = [...workspace.messages, ...(extraMessages[activeWs] ?? [])]

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  useEffect(scrollToBottom, [allMessages.length, scrollToBottom])

  const handleSend = () => {
    const text = input.trim()
    if (!text || isTyping) return

    setInput('')
    setExtraMessages((prev) => ({
      ...prev,
      [activeWs]: [...(prev[activeWs] ?? []), { role: 'user', content: text }],
    }))

    setIsTyping(true)

    // Simulate typing delay
    setTimeout(() => {
      const reply = getAgentReply(text)
      setExtraMessages((prev) => ({
        ...prev,
        [activeWs]: [...(prev[activeWs] ?? []), { role: 'assistant', content: reply }],
      }))
      setIsTyping(false)
    }, 800 + Math.random() * 600)
  }

  const repos = ['box-ide', 'api-server'] as const
  const byRepo = (repo: string) => WORKSPACES.filter((w) => w.repo === repo)

  return (
    <div className="bg-[var(--code-surface)] select-none">
      {/* Window chrome */}
      <div className="flex items-center gap-1.5 px-3.5 py-2.5">
        <div className="size-2.5 rounded-full bg-[oklch(0.72_0.19_29)]" />
        <div className="size-2.5 rounded-full bg-[oklch(0.78_0.17_85)]" />
        <div className="size-2.5 rounded-full bg-[oklch(0.72_0.19_145)]" />
        <span className="ml-3 text-[11px] text-muted-foreground/40">
          Deus Machine — {workspace.name}
        </span>
      </div>

      <div className="flex" style={{ height: 360 }}>
        {/* Sidebar */}
        <div className="hidden w-44 shrink-0 bg-foreground/[0.02] p-2.5 sm:block">
          {repos.map((repo) => (
            <div key={repo} className="mb-3">
              <div className="mb-1.5 px-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/30">
                {repo}
              </div>
              {byRepo(repo).map((ws) => (
                <button
                  key={ws.id}
                  type="button"
                  onClick={() => { setActiveWs(ws.id); setView('chat') }}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors duration-100 ${
                    ws.id === activeWs
                      ? 'bg-foreground/[0.06] text-foreground/80'
                      : 'text-muted-foreground/50 hover:text-muted-foreground/70'
                  }`}
                >
                  <div
                    className={`size-2 shrink-0 rounded-full ${
                      ws.status === 'active'
                        ? 'bg-[var(--status-active)]'
                        : ws.status === 'pending'
                          ? 'bg-[var(--status-pending)]'
                          : 'bg-[var(--status-idle)]'
                    }`}
                  />
                  <span className="truncate">{ws.name}</span>
                  {ws.time && ws.id === activeWs && (
                    <span className="ml-auto text-[10px] text-muted-foreground/30">
                      {ws.time}
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>

        {/* Main panel */}
        <div className="flex flex-1 flex-col">
          {/* View toggle bar */}
          <div className="flex items-center gap-1 px-3 py-1.5">
            <button
              type="button"
              onClick={() => setView('chat')}
              className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors duration-100 ${
                view === 'chat' ? 'bg-foreground/[0.06] text-foreground/70' : 'text-muted-foreground/35 hover:text-muted-foreground/50'
              }`}
            >
              <MessageSquare className="size-3" />
              Chat
            </button>
            <button
              type="button"
              onClick={() => setView('browser')}
              className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors duration-100 ${
                view === 'browser' ? 'bg-foreground/[0.06] text-foreground/70' : 'text-muted-foreground/35 hover:text-muted-foreground/50'
              }`}
            >
              <Globe className="size-3" />
              Browser
            </button>
            {/* Diff stats on right */}
            {workspace.diff && (
              <div className="ml-auto flex items-center gap-1.5 text-[10px]">
                <span className="truncate text-muted-foreground/30">{workspace.diff.file}</span>
                <span className="text-[var(--status-active)]">+{workspace.diff.add}</span>
                <span className="text-[oklch(0.72_0.19_29)]">-{workspace.diff.del}</span>
              </div>
            )}
          </div>

          {/* Chat view */}
          {view === 'chat' && (
            <div className="flex flex-1 flex-col overflow-hidden px-3 pb-2.5">
              <div className="flex-1 space-y-2.5 overflow-y-auto pr-1">
                {allMessages.map((msg, i) => (
                  <ChatMessage key={i} message={msg} />
                ))}
                {isTyping && (
                  <div className="flex items-center gap-1.5">
                    <div className="size-3.5 rounded-sm bg-foreground/[0.08]" />
                    <span className="text-[10px] text-muted-foreground/40">Claude is typing</span>
                    <span className="animate-pulse text-[10px] text-muted-foreground/30">...</span>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
              {/* Input */}
              <div className="mt-2 flex items-center gap-2 rounded-lg bg-foreground/[0.03] px-3 py-2 ring-1 ring-inset ring-foreground/[0.05]">
                <input
                  ref={inputRef}
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                  placeholder="Message agent..."
                  className="flex-1 bg-transparent text-[12px] text-foreground/80 placeholder:text-muted-foreground/25 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={handleSend}
                  disabled={!input.trim() || isTyping}
                  className="text-muted-foreground/30 transition-colors duration-100 hover:text-foreground/60 disabled:opacity-30"
                >
                  <Send className="size-3.5" />
                </button>
              </div>
            </div>
          )}

          {/* Browser view */}
          {view === 'browser' && (
            <div className="flex flex-1 flex-col overflow-hidden px-3 pb-2.5">
              {/* URL bar */}
              <div className="mb-2 flex items-center gap-2 rounded-md bg-foreground/[0.03] px-2.5 py-1.5 ring-1 ring-inset ring-foreground/[0.05]">
                <Globe className="size-3 text-muted-foreground/30" />
                <span className="text-[11px] text-muted-foreground/50">
                  {workspace.browserUrl ?? 'localhost:1420'}
                </span>
              </div>
              {/* Browser content mock */}
              <div className="flex flex-1 items-center justify-center rounded-md bg-foreground/[0.02]">
                <BrowserContent workspace={workspace} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ChatMessage({ message }: { message: Message }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[75%] rounded-xl rounded-tr-sm bg-foreground/[0.07] px-3 py-2 text-[12px] text-foreground/80">
          {message.content}
        </div>
      </div>
    )
  }
  if (message.role === 'tool') {
    return (
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/40">
        <div className="size-3 rounded-sm ring-1 ring-inset ring-foreground/[0.08]" />
        <span>{message.content}</span>
      </div>
    )
  }
  return (
    <div className="max-w-[85%] space-y-1.5">
      <div className="flex items-center gap-1.5">
        <div className="size-3.5 rounded-sm bg-foreground/[0.08]" />
        <span className="text-[10px] font-medium text-muted-foreground/40">Claude</span>
      </div>
      <div className="rounded-xl rounded-tl-sm bg-foreground/[0.04] px-3 py-2 text-[12px] leading-relaxed text-foreground/70">
        {message.content}
      </div>
    </div>
  )
}

function BrowserContent({ workspace }: { workspace: Workspace }) {
  return (
    <div className="flex flex-col items-center gap-3 p-6 text-center">
      {/* Simplified wireframe of a web page */}
      <div className="w-full max-w-[280px] space-y-3">
        {/* Nav bar */}
        <div className="flex items-center justify-between">
          <div className="h-2 w-16 rounded-full bg-foreground/[0.08]" />
          <div className="flex gap-2">
            <div className="h-2 w-8 rounded-full bg-foreground/[0.06]" />
            <div className="h-2 w-8 rounded-full bg-foreground/[0.06]" />
            <div className="h-2 w-8 rounded-full bg-foreground/[0.06]" />
          </div>
        </div>
        {/* Hero */}
        <div className="space-y-2 py-3">
          <div className="mx-auto h-3 w-40 rounded-full bg-foreground/[0.08]" />
          <div className="mx-auto h-2 w-52 rounded-full bg-foreground/[0.05]" />
          <div className="mx-auto h-2 w-44 rounded-full bg-foreground/[0.05]" />
        </div>
        {/* Cards */}
        <div className="grid grid-cols-3 gap-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="space-y-1.5 rounded-md bg-foreground/[0.04] p-2.5">
              <div className="h-1.5 w-8 rounded-full bg-foreground/[0.08]" />
              <div className="h-1 w-full rounded-full bg-foreground/[0.05]" />
              <div className="h-1 w-3/4 rounded-full bg-foreground/[0.05]" />
            </div>
          ))}
        </div>
        {/* Agent watching indicator */}
        <div className="flex items-center justify-center gap-1.5 pt-2">
          <div className="size-1.5 animate-pulse rounded-full bg-[var(--status-active)]" />
          <span className="text-[10px] text-muted-foreground/30">
            Agent watching {workspace.browserUrl ?? 'localhost:1420'}
          </span>
        </div>
      </div>
    </div>
  )
}
