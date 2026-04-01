import { createFileRoute } from '@tanstack/react-router'
import { Button } from '@/components/ui/button'
import { ArrowRight, Layers, Zap, GitBranch, Monitor, Bot, Sparkles } from 'lucide-react'

export const Route = createFileRoute('/')({ component: LandingPage })

function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Nav />
      <Hero />
      <Features />
      <CTA />
      <Footer />
    </div>
  )
}

function Nav() {
  return (
    <nav className="fixed top-0 inset-x-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-6">
        <span className="text-lg font-semibold tracking-tight">Deus Machine</span>
        <div className="flex items-center gap-4">
          <a
            href="https://github.com/zvadaadam/box-ide"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            GitHub
          </a>
          <Button size="sm" asChild>
            <a href="https://app.deusmachine.ai">Open App</a>
          </Button>
        </div>
      </div>
    </nav>
  )
}

function Hero() {
  return (
    <section className="relative flex min-h-[80vh] flex-col items-center justify-center px-6 pt-14 text-center">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-primary/5 via-transparent to-transparent" />
      <div className="relative max-w-3xl">
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-border/60 bg-muted/50 px-4 py-1.5 text-sm text-muted-foreground">
          <Sparkles className="size-3.5" />
          Now in early access
        </div>
        <h1 className="text-5xl font-bold tracking-tight sm:text-6xl lg:text-7xl">
          Run many AI agents.{' '}
          <span className="bg-gradient-to-r from-primary/80 to-primary bg-clip-text text-transparent">
            Ship faster.
          </span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground sm:text-xl">
          Deus Machine is an IDE built for managing multiple parallel AI coding
          agents at once. Focus on what you want to build, not the code underneath.
        </p>
        <div className="mt-10 flex flex-col items-center gap-4 sm:flex-row sm:justify-center">
          <Button size="lg" asChild>
            <a href="https://app.deusmachine.ai">
              Get Started <ArrowRight className="ml-2 size-4" />
            </a>
          </Button>
          <Button variant="outline" size="lg" asChild>
            <a
              href="https://github.com/zvadaadam/box-ide"
              target="_blank"
              rel="noopener noreferrer"
            >
              View on GitHub
            </a>
          </Button>
        </div>
      </div>
    </section>
  )
}

const features = [
  {
    icon: Layers,
    title: 'Parallel Agents',
    description:
      'Run multiple AI coding agents simultaneously across different workspaces. Each agent works independently on its own task.',
  },
  {
    icon: GitBranch,
    title: 'Git Worktrees',
    description:
      'Every workspace gets its own git worktree. Agents work on isolated branches — no conflicts, clean PRs.',
  },
  {
    icon: Monitor,
    title: 'Live Preview',
    description:
      'Watch agents work in real-time. See diffs, file changes, and terminal output as they happen.',
  },
  {
    icon: Bot,
    title: 'Claude & Codex',
    description:
      'First-class support for Claude and Codex agents. Swap models, adjust thinking, use your own API keys.',
  },
  {
    icon: Zap,
    title: 'Browser Automation',
    description:
      'Agents can see and interact with browsers. Test UIs, capture screenshots, and validate their work visually.',
  },
  {
    icon: Sparkles,
    title: 'MCP & Tools',
    description:
      'Extend agent capabilities with MCP servers, custom tools, and hooks. Configure per-workspace or globally.',
  },
]

function Features() {
  return (
    <section className="mx-auto max-w-5xl px-6 py-24">
      <h2 className="text-center text-3xl font-bold tracking-tight sm:text-4xl">
        Everything you need to orchestrate AI agents
      </h2>
      <p className="mx-auto mt-4 max-w-2xl text-center text-muted-foreground">
        A desktop app built for developers who want to multiply their output
        with AI — without losing control.
      </p>
      <div className="mt-16 grid gap-8 sm:grid-cols-2 lg:grid-cols-3">
        {features.map((feature) => (
          <div
            key={feature.title}
            className="group rounded-xl border border-border/50 bg-card/50 p-6 transition-colors hover:border-border hover:bg-card"
          >
            <feature.icon className="size-5 text-muted-foreground transition-colors group-hover:text-foreground" />
            <h3 className="mt-4 font-semibold">{feature.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              {feature.description}
            </p>
          </div>
        ))}
      </div>
    </section>
  )
}

function CTA() {
  return (
    <section className="border-t border-border/50 bg-muted/30">
      <div className="mx-auto flex max-w-3xl flex-col items-center px-6 py-24 text-center">
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
          Ready to ship faster?
        </h2>
        <p className="mt-4 text-muted-foreground">
          Download Deus Machine and start running parallel AI agents today.
        </p>
        <Button size="lg" className="mt-8" asChild>
          <a href="https://app.deusmachine.ai">
            Get Started <ArrowRight className="ml-2 size-4" />
          </a>
        </Button>
      </div>
    </section>
  )
}

function Footer() {
  return (
    <footer className="border-t border-border/50">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-6 text-sm text-muted-foreground">
        <span>Deus Machine</span>
        <a
          href="mailto:hello@deusmachine.ai"
          className="transition-colors hover:text-foreground"
        >
          hello@deusmachine.ai
        </a>
      </div>
    </footer>
  )
}
