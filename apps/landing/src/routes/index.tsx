import { createFileRoute } from '@tanstack/react-router'
import { InteractiveDemo } from '@/components/demo/interactive-demo'
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
} from 'lucide-react'

export const Route = createFileRoute('/')({ component: LandingPage })

const NAV_ITEMS = [
  { id: 'overview', label: 'Overview' },
  { id: 'the-problem', label: 'The problem' },
  { id: 'how-it-works', label: 'How it works' },
  { id: 'what-it-gives', label: 'What it gives' },
  { id: 'install', label: 'Install' },
]

function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Mobile top bar */}
      <header className="sticky top-0 z-50 flex items-center justify-between bg-background/80 px-5 py-3 backdrop-blur-xl md:hidden">
        <a href="/" className="text-[13px] font-bold tracking-[-0.01em]">
          Deus Machine
        </a>
        <a
          href="https://app.deusmachine.ai"
          className="inline-flex h-7 items-center rounded-lg bg-foreground px-2.5 text-[0.8rem] font-medium text-background transition-colors hover:bg-foreground/90"
        >
          Open App
        </a>
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
              <a href="https://github.com/zvadaadam/box-ide" target="_blank" rel="noopener noreferrer" className="px-2 py-1 text-[12px] text-muted-foreground/60 transition-colors duration-150 hover:text-foreground">GitHub</a>
              <a href="https://app.deusmachine.ai" className="px-2 py-1 text-[12px] text-muted-foreground/60 transition-colors duration-150 hover:text-foreground">Web App</a>
              <a href="mailto:hello@deusmachine.ai" className="px-2 py-1 text-[12px] text-muted-foreground/60 transition-colors duration-150 hover:text-foreground">Contact</a>
            </div>
          </div>
        </aside>

        {/* Main content */}
        <main className="min-w-0 flex-1 px-6 py-12 md:px-14 md:py-20">
          <article className="mx-auto max-w-[640px]">
            <section id="overview" className="mb-20">
              <h1 className="text-4xl font-semibold tracking-[-0.03em] sm:text-5xl">
                Give your agents<br />a place to build.
              </h1>
              <p className="mt-4 max-w-[58ch] text-base leading-[1.65] text-muted-foreground">
                You spend 80% of your time being a human clipboard between tools
                that should be talking to each other. Deus closes the loop. Plan
                the work, approve the plan, walk away. Come back to software.
              </p>
              <div className="mt-10 rounded-xl ring-1 ring-inset ring-foreground/[0.07] shadow-[0_2px_4px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.08),0_24px_48px_rgba(0,0,0,0.06)]">
                <InteractiveDemo />
              </div>
              <p className="mt-3 text-center text-[11px] text-muted-foreground/40">
                Try it — click workspaces, toggle views, send a message
              </p>
            </section>

            <section id="the-problem" className="mb-20">
              <h2 className="text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">The problem</h2>
              <div className="mt-4 max-w-[58ch] space-y-4 text-sm leading-[1.7] text-muted-foreground">
                <p>
                  Coding agents are brilliant inside a terminal and blind outside
                  of it. They write code that would take you hours, but they
                  can't see what they built. Can't click a button. Can't run the
                  tests and react to what happens.
                </p>
                <p>
                  So you sit there closing the loop manually. Copy the error.
                  Paste it back. Agent fixes it. Check again. Open the browser.
                  Screenshot. Paste. Fix. Check. Create a PR. Wait for CI.
                  It's red. Copy the logs. Paste. Fix. CI again.
                </p>
                <p className="text-foreground/80">
                  You are the most expensive, slowest, most error-prone pipe in
                  the system.
                </p>
              </div>
            </section>

            <section id="how-it-works" className="mb-20">
              <h2 className="text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">Close the loop</h2>
              <ol className="mt-5 space-y-5">
                {[
                  { title: 'Decide what to build.', text: 'Point Deus at a repo. Spin up workspaces — each one gets an isolated git worktree. No conflicts between agents.' },
                  { title: 'Approve the plan.', text: 'Tell the agent what you want. A bug fix, a new feature, a refactor. Review the plan if you want. Then let it go.' },
                  { title: 'Walk away.', text: 'The agent builds, sees what it built, tests it, catches errors, fixes them, opens a PR. It has a browser, a terminal, a file system. The full loop.' },
                  { title: 'Come back to software.', text: "Get called in only when you're genuinely needed — a decision, a direction, a wall the agent can't get past. Otherwise, it's done." },
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

            <section id="what-it-gives" className="mb-20">
              <h2 className="text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">What it gives your agents</h2>
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

            <section id="install" className="mb-20">
              <h2 className="text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">Get started</h2>
              <p className="mt-3 max-w-[58ch] text-sm leading-[1.7] text-muted-foreground">
                Open source. Runs on your hardware. Your agents, your data, your
                machine. Download the app or build from source — the box is
                yours to rebuild.
              </p>
              <div className="mt-6 flex flex-col gap-3 sm:flex-row">
                <a
                  href="https://github.com/zvadaadam/box-ide/releases"
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-foreground px-4 text-sm font-medium text-background transition-colors hover:bg-foreground/90"
                >
                  <Apple className="size-4" />
                  Download for macOS
                </a>
                <a
                  href="https://github.com/zvadaadam/box-ide"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-foreground/[0.06] px-4 text-sm font-medium text-foreground transition-colors hover:bg-foreground/[0.1]"
                >
                  View source
                  <ArrowRight className="size-4" />
                </a>
              </div>
              <div className="mt-6 rounded-lg bg-[var(--code-surface)] p-4 ring-1 ring-inset ring-foreground/[0.06]">
                <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground/60">Build from source</p>
                <pre className="mt-2.5 overflow-x-auto text-[13px] leading-relaxed text-[var(--code-foreground)]">
                  <code>{`git clone https://github.com/zvadaadam/box-ide.git
cd box-ide
bun install
bun run dev`}</code>
                </pre>
              </div>
            </section>

            <footer className="flex items-center justify-between pt-8 text-[12px] text-muted-foreground/50">
              <span>Deus — same letters as Devs, different power dynamic</span>
              <a href="mailto:hello@deusmachine.ai" className="transition-colors duration-150 hover:text-foreground">hello@deusmachine.ai</a>
            </footer>
          </article>
        </main>
      </div>
    </div>
  )
}

const FEATURES = [
  { icon: Layers, title: 'Parallel workspaces', description: 'Run multiple agents at once across different tasks. Each workspace is isolated — no conflicts, no context-switching.' },
  { icon: GitBranch, title: 'Isolated branches', description: 'Every workspace gets its own git worktree. Agents commit to clean branches. PRs come out ready to review.' },
  { icon: Globe, title: 'A real browser', description: "Agents can see what they built. Click buttons. Screenshot errors. Test the UI. The loop that was open is now closed." },
  { icon: Monitor, title: 'Live preview', description: "Watch agents work in real-time. Diffs, file changes, terminal output — you see everything without being in the room." },
  { icon: Bot, title: 'Bring your own agent', description: "Claude Code, Codex, whatever you run. Deus doesn't replace your agent. It gives your agent a body." },
  { icon: Wrench, title: 'Your loop, your tools', description: 'MCP servers, custom hooks, per-workspace config. Your build process is different from everyone else\'s. Deus adapts.' },
  { icon: Terminal, title: 'Full terminal', description: 'Agents run commands, install dependencies, run tests, handle CI failures. No more copy-pasting logs.' },
  { icon: Download, title: 'Mobile access', description: 'Pair your phone and monitor agents from anywhere. Get called in when you\'re needed. Not before.' },
]
