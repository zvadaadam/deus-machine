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
  ChevronRight,
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
      {/* Mobile top nav */}
      <header className="sticky top-0 z-50 flex items-center justify-between border-b border-border/50 bg-background/80 px-4 py-3 backdrop-blur-xl md:hidden">
        <a href="/" className="text-base font-semibold tracking-tight">
          Deus Machine
        </a>
        <Button size="sm" asChild>
          <a href="https://app.deusmachine.ai">Open App</a>
        </Button>
      </header>

      <div className="mx-auto flex max-w-6xl">
        {/* Left sidebar — desktop only */}
        <aside className="sticky top-0 hidden h-screen w-56 shrink-0 border-r border-border/50 md:block">
          <div className="flex h-full flex-col px-4 py-6">
            {/* Brand */}
            <a href="/" className="mb-8 flex items-center gap-2.5 px-2">
              <div className="flex size-7 items-center justify-center rounded-md bg-foreground">
                <span className="text-xs font-bold text-background">D</span>
              </div>
              <span className="text-sm font-semibold tracking-tight">
                Deus Machine
              </span>
            </a>

            {/* Nav links */}
            <nav className="flex flex-col gap-0.5">
              {NAV_ITEMS.map((item) => (
                <a
                  key={item.id}
                  href={`#${item.id}`}
                  className="rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors duration-100 hover:bg-foreground/[0.04] hover:text-foreground"
                >
                  {item.label}
                </a>
              ))}
            </nav>

            {/* Sidebar footer */}
            <div className="mt-auto flex flex-col gap-2 border-t border-border/50 pt-4">
              <a
                href="https://github.com/zvadaadam/box-ide"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 px-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                GitHub
                <ChevronRight className="ml-auto size-3.5" />
              </a>
              <a
                href="https://app.deusmachine.ai"
                className="flex items-center gap-2 px-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                Web App
                <ChevronRight className="ml-auto size-3.5" />
              </a>
              <a
                href="mailto:hello@deusmachine.ai"
                className="flex items-center gap-2 px-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                Contact
                <ChevronRight className="ml-auto size-3.5" />
              </a>
            </div>
          </div>
        </aside>

        {/* Main content */}
        <main className="min-w-0 flex-1 px-6 py-10 md:px-12 md:py-16">
          <article className="mx-auto max-w-2xl">
            {/* Overview */}
            <section id="overview" className="mb-16">
              <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
                Deus Machine
              </h1>
              <p className="mt-3 text-lg leading-relaxed text-muted-foreground">
                A desktop IDE for running multiple AI coding agents in parallel.
                Point them at tasks, watch them work, review and merge.
              </p>

              {/* Product screenshot placeholder */}
              <div className="mt-8 overflow-hidden rounded-xl border border-border/60">
                <ProductScreenshot />
              </div>
            </section>

            {/* Install */}
            <section id="install" className="mb-16">
              <h2 className="text-xl font-semibold tracking-tight">Install</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
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

              <div className="mt-6 rounded-lg border border-border/50 bg-muted/30 p-4">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Build from source
                </p>
                <pre className="mt-2 overflow-x-auto text-sm text-foreground/80">
                  <code>{`git clone https://github.com/zvadaadam/box-ide.git
cd box-ide
bun install
bun run dev`}</code>
                </pre>
              </div>
            </section>

            {/* How it works */}
            <section id="how-it-works" className="mb-16">
              <h2 className="text-xl font-semibold tracking-tight">
                How it works
              </h2>
              <ol className="mt-4 space-y-4 text-sm leading-relaxed text-muted-foreground">
                <li className="flex gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground text-xs font-semibold text-background">
                    1
                  </span>
                  <span>
                    <strong className="text-foreground">
                      Open a project.
                    </strong>{' '}
                    Point Deus Machine at any git repository on your machine or
                    clone from GitHub.
                  </span>
                </li>
                <li className="flex gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground text-xs font-semibold text-background">
                    2
                  </span>
                  <span>
                    <strong className="text-foreground">
                      Spin up workspaces.
                    </strong>{' '}
                    Each workspace creates an isolated git worktree. Run as many
                    as you want — they don't interfere with each other.
                  </span>
                </li>
                <li className="flex gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground text-xs font-semibold text-background">
                    3
                  </span>
                  <span>
                    <strong className="text-foreground">
                      Give agents instructions.
                    </strong>{' '}
                    Type what you want — a bug fix, a new feature, a refactor.
                    The agent takes it from there.
                  </span>
                </li>
                <li className="flex gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground text-xs font-semibold text-background">
                    4
                  </span>
                  <span>
                    <strong className="text-foreground">
                      Review and merge.
                    </strong>{' '}
                    Watch agents work in real-time. See diffs, file changes, and
                    terminal output. Create PRs when you're happy.
                  </span>
                </li>
              </ol>
            </section>

            {/* Features */}
            <section id="features" className="mb-16">
              <h2 className="text-xl font-semibold tracking-tight">
                Features
              </h2>
              <div className="mt-6 space-y-1">
                {FEATURES.map((feature) => (
                  <div
                    key={feature.title}
                    className="group flex gap-4 rounded-lg px-3 py-3 transition-colors duration-100 hover:bg-foreground/[0.04]"
                  >
                    <feature.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium">{feature.title}</p>
                      <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
                        {feature.description}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* Architecture */}
            <section id="architecture" className="mb-16">
              <h2 className="text-xl font-semibold tracking-tight">
                Architecture
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                Deus Machine is an Electron app with a React frontend and a
                Node.js backend. The agent-server runs as a separate process,
                wrapping Claude and Codex SDKs. All communication flows through
                WebSockets.
              </p>
              <div className="mt-4 rounded-lg border border-border/50 bg-muted/30 p-4">
                <pre className="overflow-x-auto text-xs leading-relaxed text-foreground/70">
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
            <footer className="flex items-center justify-between border-t border-border/50 pt-6 text-sm text-muted-foreground">
              <span>Deus Machine</span>
              <a
                href="mailto:hello@deusmachine.ai"
                className="transition-colors hover:text-foreground"
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

/** Placeholder product screenshot — a stylized mock of the Deus IDE */
function ProductScreenshot() {
  return (
    <div className="bg-muted/30 p-0">
      {/* Window chrome */}
      <div className="flex items-center gap-1.5 border-b border-border/40 px-3 py-2">
        <div className="size-2.5 rounded-full bg-foreground/10" />
        <div className="size-2.5 rounded-full bg-foreground/10" />
        <div className="size-2.5 rounded-full bg-foreground/10" />
        <span className="ml-3 text-xs text-muted-foreground/50">
          Deus Machine
        </span>
      </div>

      {/* App layout mock */}
      <div className="flex" style={{ height: 320 }}>
        {/* Sidebar mock */}
        <div className="hidden w-48 shrink-0 border-r border-border/30 p-3 sm:block">
          {/* Repo section */}
          <div className="mb-3">
            <div className="mb-1.5 px-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/40">
              box-ide
            </div>
            {['feat/auth-flow', 'fix/sidebar-bug', 'refactor/api'].map(
              (name, i) => (
                <div
                  key={name}
                  className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-xs ${i === 0 ? 'bg-foreground/[0.06] text-foreground' : 'text-muted-foreground/60'}`}
                >
                  <div
                    className={`size-2 rounded-full ${i === 0 ? 'bg-primary' : i === 1 ? 'bg-amber-500/60' : 'bg-muted-foreground/20'}`}
                  />
                  <span className="truncate">{name}</span>
                  {i === 0 && (
                    <span className="ml-auto text-[10px] text-muted-foreground/40">
                      2m
                    </span>
                  )}
                </div>
              ),
            )}
          </div>
          {/* Second repo */}
          <div>
            <div className="mb-1.5 px-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/40">
              api-server
            </div>
            {['add-caching', 'perf/queries'].map((name, i) => (
              <div
                key={name}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground/60"
              >
                <div
                  className={`size-2 rounded-full ${i === 0 ? 'bg-green-500/60' : 'bg-muted-foreground/20'}`}
                />
                <span className="truncate">{name}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Chat area mock */}
        <div className="flex flex-1 flex-col p-4">
          <div className="space-y-3">
            {/* User message */}
            <div className="flex justify-end">
              <div className="max-w-[70%] rounded-xl rounded-tr-sm bg-foreground/[0.08] px-3 py-2 text-xs text-foreground/70">
                Add error handling to the auth middleware
              </div>
            </div>
            {/* Agent response */}
            <div className="max-w-[80%] space-y-1.5">
              <div className="flex items-center gap-1.5">
                <div className="size-4 rounded-sm bg-foreground/10" />
                <span className="text-[10px] font-medium text-muted-foreground/50">
                  Claude
                </span>
              </div>
              <div className="rounded-xl rounded-tl-sm bg-muted/50 px-3 py-2 text-xs leading-relaxed text-foreground/60">
                I'll add try-catch blocks around the token verification and
                session validation. Let me also add proper error responses with
                status codes...
              </div>
            </div>
            {/* Tool use indicator */}
            <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/40">
              <div className="size-3 rounded-sm border border-border/40" />
              <span>Editing auth/middleware.ts</span>
              <span className="ml-1 text-green-500/60">+24</span>
              <span className="text-red-500/60">-3</span>
            </div>
          </div>
          {/* Input area */}
          <div className="mt-auto">
            <div className="rounded-lg border border-border/40 bg-muted/20 px-3 py-2 text-xs text-muted-foreground/30">
              Message agent...
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
