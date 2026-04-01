import { createFileRoute } from "@tanstack/react-router";
import { InteractiveDemo } from "@/components/demo/interactive-demo";
import {
  ArrowRight,
  Download,
  Layers,
  GitBranch,
  Monitor,
  Bot,
  Wrench,
  Terminal,
  Apple,
  Globe,
} from "lucide-react";

export const Route = createFileRoute("/")({ component: LandingPage });

const NAV_ITEMS = [
  { id: "overview", label: "Overview" },
  { id: "the-problem", label: "The problem" },
  { id: "how-it-works", label: "How it works" },
  { id: "what-it-gives", label: "What it gives" },
  { id: "install", label: "Install" },
];

function LandingPage() {
  return (
    <div className="bg-background text-foreground min-h-screen">
      {/* Mobile top bar */}
      <header className="bg-background/80 sticky top-0 z-50 flex items-center justify-between px-5 py-3 backdrop-blur-xl md:hidden">
        <a href="/" className="text-[13px] font-bold tracking-[-0.01em]">
          Deus Machine
        </a>
        <a
          href="https://app.deusmachine.ai"
          className="bg-foreground text-background hover:bg-foreground/90 inline-flex h-7 items-center rounded-lg px-2.5 text-[0.8rem] font-medium transition-colors"
        >
          Open App
        </a>
      </header>

      <div className="flex">
        {/* Left sidebar */}
        <aside className="sticky top-0 hidden h-screen w-48 shrink-0 md:block">
          <div className="flex h-full flex-col px-6 py-10">
            <a href="/" className="mb-8 flex items-center gap-2">
              <div className="bg-foreground flex size-5 items-center justify-center rounded-[4px]">
                <span className="text-background text-[9px] font-bold">D</span>
              </div>
              <span className="text-[13px] font-semibold tracking-[-0.01em]">Deus Machine</span>
            </a>
            <nav className="flex flex-col gap-px">
              {NAV_ITEMS.map((item) => (
                <a
                  key={item.id}
                  href={`#${item.id}`}
                  className="text-muted-foreground hover:text-foreground py-1.5 text-[13px] transition-colors duration-150"
                >
                  {item.label}
                </a>
              ))}
            </nav>
            <div className="mt-auto flex flex-col gap-0.5 pb-4">
              <a
                href="https://github.com/zvadaadam/box-ide"
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground/40 hover:text-muted-foreground py-1 text-[12px] transition-colors duration-150"
              >
                GitHub
              </a>
              <a
                href="https://app.deusmachine.ai"
                className="text-muted-foreground/40 hover:text-muted-foreground py-1 text-[12px] transition-colors duration-150"
              >
                Web App
              </a>
              <a
                href="mailto:hello@deusmachine.ai"
                className="text-muted-foreground/40 hover:text-muted-foreground py-1 text-[12px] transition-colors duration-150"
              >
                Contact
              </a>
            </div>
          </div>
        </aside>

        {/* Main content */}
        <main className="flex min-w-0 flex-1 justify-center px-6 py-12 md:py-16">
          <article className="w-full max-w-[620px]">
            {/* Hero */}
            <section id="overview" className="mb-24">
              <h1 className="text-[clamp(2.25rem,5vw,3.25rem)] leading-[1.08] font-semibold tracking-[-0.035em]">
                Give your agents
                <br />a place to build.
              </h1>
              <p className="text-muted-foreground mt-5 max-w-[54ch] text-[15px] leading-[1.7]">
                You spend 80% of your time being a human clipboard between tools that should be
                talking to each other. Deus closes the loop. Plan the work, approve the plan, walk
                away. Come back to software.
              </p>
              <div className="mt-12 overflow-hidden rounded-xl shadow-[0_1px_2px_rgba(0,0,0,0.06),0_8px_24px_rgba(0,0,0,0.12)]">
                <InteractiveDemo />
              </div>
              <p className="text-muted-foreground/30 mt-3 text-center text-[11px]">
                Try it — click workspaces, toggle views, send a message
              </p>
            </section>

            {/* The problem */}
            <section id="the-problem" className="mb-24">
              <SectionLabel>The problem</SectionLabel>
              <div className="text-muted-foreground mt-4 max-w-[54ch] space-y-4 text-[15px] leading-[1.7]">
                <p>
                  Coding agents are brilliant inside a terminal and blind outside of it. They write
                  code that would take you hours, but they can't see what they built. Can't click a
                  button. Can't run the tests and react to what happens.
                </p>
                <p>
                  So you sit there closing the loop manually. Copy the error. Paste it back. Agent
                  fixes it. Check again. Open the browser. Screenshot. Paste. Fix. Check. Create a
                  PR. Wait for CI. It's red. Copy the logs. Paste. Fix. CI again.
                </p>
                <p className="text-foreground/80">
                  You are the most expensive, slowest, most error-prone pipe in the system.
                </p>
              </div>
            </section>

            {/* How it works */}
            <section id="how-it-works" className="mb-24">
              <SectionLabel>Close the loop</SectionLabel>
              <ol className="mt-6 space-y-6">
                {[
                  {
                    title: "Decide what to build.",
                    text: "Point Deus at a repo. Spin up workspaces — each one gets an isolated git worktree. No conflicts between agents.",
                  },
                  {
                    title: "Approve the plan.",
                    text: "Tell the agent what you want. A bug fix, a new feature, a refactor. Review the plan if you want. Then let it go.",
                  },
                  {
                    title: "Walk away.",
                    text: "The agent builds, sees what it built, tests it, catches errors, fixes them, opens a PR. It has a browser, a terminal, a file system. The full loop.",
                  },
                  {
                    title: "Come back to software.",
                    text: "Get called in only when you're genuinely needed — a decision, a direction, a wall the agent can't get past. Otherwise, it's done.",
                  },
                ].map((step, i) => (
                  <li key={i} className="flex gap-4">
                    <span className="text-muted-foreground/25 w-5 shrink-0 pt-px text-[15px] tabular-nums">
                      {i + 1}.
                    </span>
                    <span className="text-muted-foreground text-[15px] leading-[1.7]">
                      <strong className="text-foreground font-medium">{step.title}</strong>{" "}
                      {step.text}
                    </span>
                  </li>
                ))}
              </ol>
              <a
                href="https://app.deusmachine.ai"
                className="text-foreground/60 hover:text-foreground mt-10 inline-flex items-center gap-1.5 text-[15px] transition-colors duration-150"
              >
                Open Deus Machine
                <ArrowRight className="size-3.5" />
              </a>
            </section>

            {/* Features */}
            <section id="what-it-gives" className="mb-24">
              <SectionLabel>What it gives your agents</SectionLabel>
              <div className="mt-6 space-y-1">
                {FEATURES.map((f) => (
                  <div key={f.title} className="flex gap-4 py-3.5">
                    <f.icon className="text-muted-foreground/30 mt-0.5 size-[18px] shrink-0" />
                    <div>
                      <p className="text-[15px] font-medium">{f.title}</p>
                      <p className="text-muted-foreground mt-1 text-[14px] leading-[1.7]">
                        {f.description}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            {/* Install */}
            <section id="install" className="mb-16">
              <SectionLabel>Get started</SectionLabel>
              <p className="text-muted-foreground mt-4 max-w-[54ch] text-[15px] leading-[1.7]">
                Open source. Runs on your hardware. Your agents, your data, your machine. Download
                the app or build from source — the box is yours to rebuild.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <a
                  href="https://github.com/zvadaadam/box-ide/releases"
                  className="bg-foreground text-background hover:bg-foreground/90 inline-flex h-10 items-center justify-center gap-2 rounded-lg px-5 text-sm font-medium transition-colors"
                >
                  <Apple className="size-4" />
                  Download for macOS
                </a>
                <a
                  href="https://github.com/zvadaadam/box-ide"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.1] inline-flex h-10 items-center justify-center gap-2 rounded-lg px-5 text-sm font-medium transition-colors"
                >
                  View source
                  <ArrowRight className="size-4" />
                </a>
              </div>
              <div className="mt-8 rounded-lg bg-[var(--code-surface)] p-5">
                <p className="text-muted-foreground/40 text-[10px] font-semibold tracking-[0.1em] uppercase">
                  Build from source
                </p>
                <pre className="mt-3 overflow-x-auto text-[13px] leading-relaxed text-[var(--code-foreground)]">
                  <code>{`git clone https://github.com/zvadaadam/box-ide.git
cd box-ide
bun install
bun run dev`}</code>
                </pre>
              </div>
            </section>

            {/* Footer */}
            <footer className="text-muted-foreground/30 flex items-center justify-between py-8 text-[12px]">
              <span>Deus — same letters as Devs, different power dynamic</span>
              <a
                href="mailto:hello@deusmachine.ai"
                className="hover:text-muted-foreground transition-colors duration-150"
              >
                hello@deusmachine.ai
              </a>
            </footer>
          </article>
        </main>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <h2 className="text-muted-foreground/60 text-[11px] font-medium tracking-[0.08em] uppercase">
      {children}
    </h2>
  );
}

const FEATURES = [
  {
    icon: Layers,
    title: "Parallel workspaces",
    description:
      "Run multiple agents at once across different tasks. Each workspace is isolated — no conflicts, no context-switching.",
  },
  {
    icon: GitBranch,
    title: "Isolated branches",
    description:
      "Every workspace gets its own git worktree. Agents commit to clean branches. PRs come out ready to review.",
  },
  {
    icon: Globe,
    title: "A real browser",
    description:
      "Agents can see what they built. Click buttons. Screenshot errors. Test the UI. The loop that was open is now closed.",
  },
  {
    icon: Monitor,
    title: "Live preview",
    description:
      "Watch agents work in real-time. Diffs, file changes, terminal output — you see everything without being in the room.",
  },
  {
    icon: Bot,
    title: "Bring your own agent",
    description:
      "Claude Code, Codex, whatever you run. Deus doesn't replace your agent. It gives your agent a body.",
  },
  {
    icon: Wrench,
    title: "Your loop, your tools",
    description:
      "MCP servers, custom hooks, per-workspace config. Your build process is different from everyone else's. Deus adapts.",
  },
  {
    icon: Terminal,
    title: "Full terminal",
    description:
      "Agents run commands, install dependencies, run tests, handle CI failures. No more copy-pasting logs.",
  },
  {
    icon: Download,
    title: "Mobile access",
    description:
      "Pair your phone and monitor agents from anywhere. Get called in when you're needed. Not before.",
  },
];
