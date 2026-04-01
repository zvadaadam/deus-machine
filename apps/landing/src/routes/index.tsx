import { createFileRoute } from '@tanstack/react-router'
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
            {/* Brand */}
            <a href="/" className="mb-10 flex items-center gap-2.5">
              <div className="flex size-6 items-center justify-center rounded-[5px] bg-foreground">
                <span className="text-[10px] font-bold text-background">D</span>
              </div>
              <span className="text-[13px] font-bold tracking-[-0.01em]">
                Deus Machine
              </span>
            </a>

            {/* Nav */}
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

            {/* Footer links */}
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
            {/* Overview */}
            <section id="overview" className="mb-20">
              <h1 className="text-4xl font-semibold tracking-[-0.03em] sm:text-5xl">
                Deus Machine
              </h1>
              <p className="mt-4 max-w-[58ch] text-base leading-[1.65] text-muted-foreground">
                A desktop IDE for running multiple AI coding agents in parallel.
                Point them at tasks, watch them work, review and merge.
              </p>

              {/* Product screenshot */}
              <div className="mt-10 overflow-hidden rounded-xl ring-1 ring-inset ring-foreground/[0.07] shadow-[0_2px_4px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.08),0_24px_48px_rgba(0,0,0,0.06)]">
                <ProductScreenshot />
              </div>
            </section>

            {/* Install */}
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

            {/* How it works */}
            <section id="how-it-works" className="mb-20">
              <h2 className="text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                How it works
              </h2>
              <ol className="mt-5 space-y-5">
                {[
                  {
                    title: 'Open a project.',
                    text: 'Point Deus Machine at any git repository on your machine or clone from GitHub.',
                  },
                  {
                    title: 'Spin up workspaces.',
                    text: "Each workspace creates an isolated git worktree. Run as many as you want — they don't interfere with each other.",
                  },
                  {
                    title: 'Give agents instructions.',
                    text: 'Type what you want — a bug fix, a new feature, a refactor. The agent takes it from there.',
                  },
                  {
                    title: 'Review and merge.',
                    text: 'Watch agents work in real-time. See diffs, file changes, and terminal output. Create PRs when ready.',
                  },
                ].map((step, i) => (
                  <li key={i} className="flex gap-3.5">
                    <span className="w-4 shrink-0 pt-px text-sm tabular-nums text-muted-foreground/40">
                      {i + 1}.
                    </span>
                    <span className="text-sm leading-[1.7] text-muted-foreground">
                      <strong className="font-medium text-foreground">
                        {step.title}
                      </strong>{' '}
                      {step.text}
                    </span>
                  </li>
                ))}
              </ol>
            </section>

            {/* Features */}
            <section id="features" className="mb-20">
              <h2 className="text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                Features
              </h2>
              <div className="mt-5 space-y-0.5">
                {FEATURES.map((feature) => (
                  <div
                    key={feature.title}
                    className="flex gap-4 py-3"
                  >
                    <feature.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground/50" />
                    <div>
                      <p className="text-sm font-medium">{feature.title}</p>
                      <p className="mt-0.5 text-sm leading-[1.7] text-muted-foreground">
                        {feature.description}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* Architecture */}
            <section id="architecture" className="mb-20">
              <h2 className="text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                Architecture
              </h2>
              <p className="mt-3 max-w-[58ch] text-sm leading-[1.7] text-muted-foreground">
                Electron app with a React frontend and Node.js backend. The
                agent-server runs as a separate process, wrapping Claude and
                Codex SDKs. All communication flows through WebSockets.
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

            {/* Footer */}
            <footer className="flex items-center justify-between pt-8 text-[12px] text-muted-foreground/50">
              <span>Deus Machine</span>
              <a
                href="mailto:hello@deusmachine.ai"
                className="transition-colors duration-150 hover:text-foreground"
              >
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
  {
    icon: Layers,
    title: 'Parallel agents',
    description:
      'Run multiple AI coding agents simultaneously. Each agent works in its own workspace on its own task.',
  },
  {
    icon: GitBranch,
    title: 'Git worktrees',
    description:
      'Every workspace gets an isolated git worktree. No conflicts between agents, clean branches, easy PRs.',
  },
  {
    icon: Monitor,
    title: 'Live preview',
    description:
      'Watch agents work in real-time. See diffs, file changes, and terminal output as they happen.',
  },
  {
    icon: Bot,
    title: 'Claude & Codex',
    description:
      'First-class support for Claude and Codex agents. Swap models, adjust thinking effort, use your own API keys.',
  },
  {
    icon: Zap,
    title: 'Browser automation',
    description:
      'Agents can see and interact with browsers. Test UIs, capture screenshots, validate work visually.',
  },
  {
    icon: Wrench,
    title: 'MCP & tools',
    description:
      'Extend agent capabilities with MCP servers, custom tools, and hooks. Configure per-workspace or globally.',
  },
  {
    icon: Terminal,
    title: 'Terminal access',
    description:
      'Full terminal access per workspace. Agents run commands, install dependencies, and run tests.',
  },
  {
    icon: Download,
    title: 'Mobile access',
    description:
      'Pair your phone to monitor and control agents from anywhere via the web app.',
  },
]

/** Stylized mock of the Deus IDE — sidebar + chat layout */
function ProductScreenshot() {
  return (
    <div className="bg-[var(--code-surface)]">
      {/* Window chrome */}
      <div className="flex items-center gap-1.5 px-3.5 py-2.5">
        <div className="size-2.5 rounded-full bg-[oklch(0.72_0.19_29)]" />
        <div className="size-2.5 rounded-full bg-[oklch(0.78_0.17_85)]" />
        <div className="size-2.5 rounded-full bg-[oklch(0.72_0.19_145)]" />
        <span className="ml-3 text-[11px] text-muted-foreground/40">
          Deus Machine
        </span>
      </div>

      {/* App layout */}
      <div className="flex" style={{ height: 340 }}>
        {/* Sidebar mock */}
        <div className="hidden w-44 shrink-0 bg-foreground/[0.02] p-3 sm:block">
          {/* Repo section */}
          <div className="mb-4">
            <div className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/30">
              box-ide
            </div>
            {[
              { name: 'feat/auth-flow', status: 'active', time: '2m' },
              { name: 'fix/sidebar-bug', status: 'pending', time: '' },
              { name: 'refactor/api', status: 'idle', time: '' },
            ].map((ws) => (
              <div
                key={ws.name}
                className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] ${ws.status === 'active' ? 'bg-foreground/[0.05] text-foreground/80' : 'text-muted-foreground/50'}`}
              >
                <div
                  className={`size-2 rounded-full ${
                    ws.status === 'active'
                      ? 'bg-[var(--status-active)]'
                      : ws.status === 'pending'
                        ? 'bg-[var(--status-pending)]'
                        : 'bg-[var(--status-idle)]'
                  }`}
                />
                <span className="truncate">{ws.name}</span>
                {ws.time && (
                  <span className="ml-auto text-[10px] text-muted-foreground/30">
                    {ws.time}
                  </span>
                )}
              </div>
            ))}
          </div>
          {/* Second repo */}
          <div>
            <div className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/30">
              api-server
            </div>
            {[
              { name: 'add-caching', status: 'active' },
              { name: 'perf/queries', status: 'idle' },
            ].map((ws) => (
              <div
                key={ws.name}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-muted-foreground/50"
              >
                <div
                  className={`size-2 rounded-full ${ws.status === 'active' ? 'bg-[var(--status-active)]' : 'bg-[var(--status-idle)]'}`}
                />
                <span className="truncate">{ws.name}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Chat area */}
        <div className="flex flex-1 flex-col p-4">
          <div className="space-y-3">
            {/* User message */}
            <div className="flex justify-end">
              <div className="max-w-[70%] rounded-xl rounded-tr-sm bg-foreground/[0.07] px-3 py-2 text-[12px] text-foreground/80">
                Add error handling to the auth middleware
              </div>
            </div>
            {/* Agent response */}
            <div className="max-w-[80%] space-y-1.5">
              <div className="flex items-center gap-1.5">
                <div className="size-3.5 rounded-sm bg-foreground/[0.08]" />
                <span className="text-[10px] font-medium text-muted-foreground/40">
                  Claude
                </span>
              </div>
              <div className="rounded-xl rounded-tl-sm bg-foreground/[0.04] px-3 py-2 text-[12px] leading-relaxed text-foreground/70">
                I'll add try-catch blocks around the token verification and
                session validation. Let me also add proper error responses with
                status codes...
              </div>
            </div>
            {/* Tool use indicator */}
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/40">
              <div className="size-3 rounded-sm ring-1 ring-inset ring-foreground/[0.08]" />
              <span>Editing auth/middleware.ts</span>
              <span className="ml-1 text-[var(--status-active)]">+24</span>
              <span className="text-[oklch(0.72_0.19_29)]">-3</span>
            </div>
          </div>
          {/* Input */}
          <div className="mt-auto">
            <div className="rounded-lg bg-foreground/[0.03] px-3 py-2.5 text-[12px] text-muted-foreground/25 ring-1 ring-inset ring-foreground/[0.05]">
              Message agent...
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
