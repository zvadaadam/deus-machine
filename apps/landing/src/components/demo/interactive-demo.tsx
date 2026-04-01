import { useState, useRef, useEffect, useCallback } from 'react'
import {
  Globe,
  MessageSquare,
  Send,
  Terminal,
  RefreshCw,
} from 'lucide-react'
import type { Message, Workspace } from './data'
import { WORKSPACES, getAgentReply } from './data'

export function InteractiveDemo() {
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
    setTimeout(() => {
      const reply = getAgentReply(text)
      setExtraMessages((prev) => ({
        ...prev,
        [activeWs]: [
          ...(prev[activeWs] ?? []),
          { role: 'assistant', content: reply },
          { role: 'cta', content: '' },
        ],
      }))
      setIsTyping(false)
    }, 800 + Math.random() * 600)
  }

  const repos = ['box-ide', 'api-server'] as const
  const byRepo = (repo: string) => WORKSPACES.filter((w) => w.repo === repo)

  return (
    <div className="bg-[var(--code-surface)]">
      {/* Window chrome */}
      <div className="flex items-center gap-1.5 px-3.5 py-2.5">
        <div className="size-2.5 rounded-full bg-[oklch(0.72_0.19_29)]" />
        <div className="size-2.5 rounded-full bg-[oklch(0.78_0.17_85)]" />
        <div className="size-2.5 rounded-full bg-[oklch(0.72_0.19_145)]" />
        <span className="ml-3 text-[11px] text-muted-foreground/40">
          Deus Machine — {workspace.name}
        </span>
      </div>

      <div className="flex" style={{ height: 380 }}>
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
                      : 'text-muted-foreground/50 hover:bg-foreground/[0.03] hover:text-muted-foreground/70'
                  }`}
                >
                  <StatusDot status={ws.status} />
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
            <ViewTab active={view === 'chat'} onClick={() => setView('chat')}>
              <MessageSquare className="size-3" />
              Chat
            </ViewTab>
            <ViewTab active={view === 'browser'} onClick={() => setView('browser')}>
              <Globe className="size-3" />
              Browser
            </ViewTab>
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
              <div className="flex-1 space-y-1 overflow-y-auto pr-1">
                {allMessages.map((msg, i) => (
                  <ChatMessage key={`${activeWs}-${i}`} message={msg} />
                ))}
                {isTyping && (
                  <div className="flex items-center gap-2 px-2 py-1">
                    <div className="size-3 animate-spin rounded-full border border-muted-foreground/20 border-t-muted-foreground/50" />
                    <span className="font-mono text-[10px] tabular-nums text-muted-foreground/40">
                      thinking...
                    </span>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
              {/* Input */}
              <div className="mt-2 rounded-2xl bg-accent shadow-sm">
                <div className="flex items-center gap-2 px-3 py-2.5">
                  <input
                    ref={inputRef}
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                    placeholder="Message agent..."
                    className="flex-1 bg-transparent text-[12px] text-foreground/80 placeholder:text-muted-foreground/30 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={handleSend}
                    disabled={!input.trim() || isTyping}
                    className={`flex size-5 items-center justify-center rounded-full transition-colors duration-100 ${
                      input.trim() && !isTyping
                        ? 'bg-foreground text-background'
                        : 'bg-foreground/10 text-muted-foreground/30'
                    }`}
                  >
                    <Send className="size-2.5" />
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Browser view */}
          {view === 'browser' && (
            <BrowserPanel workspace={workspace} />
          )}
        </div>
      </div>
    </div>
  )
}

function StatusDot({ status }: { status: Workspace['status'] }) {
  return (
    <div
      className={`size-2 shrink-0 rounded-full ${
        status === 'active'
          ? 'bg-[var(--status-active)]'
          : status === 'pending'
            ? 'bg-[var(--status-pending)]'
            : 'bg-[var(--status-idle)]'
      }`}
    />
  )
}

function ViewTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors duration-100 ${
        active ? 'bg-foreground/[0.06] text-foreground/70' : 'text-muted-foreground/35 hover:text-muted-foreground/50'
      }`}
    >
      {children}
    </button>
  )
}

function ChatMessage({ message }: { message: Message }) {
  if (message.role === 'user') {
    return (
      <div className="flex justify-end pt-4">
        <div className="max-w-[85%] rounded-xl bg-accent px-3 py-2 text-[12px] text-foreground">
          {message.content}
        </div>
      </div>
    )
  }
  if (message.role === 'tool') {
    return (
      <div className="flex items-center gap-2 px-2 py-1 text-[12px] opacity-70">
        <Terminal className="size-3 text-amber-500/70" />
        <span className="font-medium text-foreground/60">{message.content}</span>
      </div>
    )
  }
  if (message.role === 'cta') {
    return (
      <div className="mt-1 rounded-xl bg-foreground/[0.04] px-3 py-3 text-center">
        <p className="text-[11px] leading-relaxed text-muted-foreground/60">
          This is a demo.{' '}
          <a
            href="https://github.com/zvadaadam/box-ide/releases"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-foreground/80 underline underline-offset-2 transition-colors hover:text-foreground"
          >
            Download Deus
          </a>
          {' '}to close the loop for real.
        </p>
      </div>
    )
  }
  // Assistant — with Claude label, no bubble
  return (
    <div className="space-y-1 py-1">
      <div className="flex items-center gap-1.5 px-2">
        <div className="size-3.5 rounded-sm bg-foreground/[0.08]" />
        <span className="text-[10px] font-medium text-muted-foreground/40">Claude</span>
      </div>
      <div className="px-2 text-[12px] leading-relaxed text-foreground/80">
        {message.content}
      </div>
    </div>
  )
}

function BrowserPanel({ workspace }: { workspace: Workspace }) {
  const url = workspace.browserUrl ?? 'localhost:1420'
  const isExternal = url.includes('3001')

  return (
    <div className="flex flex-1 flex-col overflow-hidden px-3 pb-2.5">
      {/* Browser chrome */}
      <div className="flex items-center gap-2 rounded-t-lg bg-foreground/[0.04] px-3 py-2">
        <div className="flex gap-1">
          <div className="size-2 rounded-full bg-[oklch(0.72_0.19_29)]/50" />
          <div className="size-2 rounded-full bg-[oklch(0.78_0.17_85)]/50" />
          <div className="size-2 rounded-full bg-[oklch(0.72_0.19_145)]/50" />
        </div>
        <div className="flex flex-1 items-center gap-1.5 rounded-md bg-foreground/[0.04] px-2 py-1">
          <Globe className="size-2.5 text-muted-foreground/30" />
          <span className="text-[10px] text-muted-foreground/50">{url}</span>
        </div>
        <RefreshCw className="size-3 text-muted-foreground/25" />
      </div>
      {/* Browser content — iframe for deusmachine.ai, wireframe for others */}
      <div className="flex-1 overflow-hidden rounded-b-lg ring-1 ring-inset ring-foreground/[0.06]">
        {!isExternal ? (
          <iframe
            src="https://deusmachine.ai"
            title="Browser preview"
            className="h-full w-full border-0"
            sandbox="allow-scripts allow-same-origin"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full items-center justify-center bg-foreground/[0.02]">
            <BrowserWireframe />
          </div>
        )}
      </div>
      {/* Agent watching */}
      <div className="flex items-center justify-center gap-1.5 py-1.5">
        <div className="size-1.5 animate-pulse rounded-full bg-[var(--status-active)]" />
        <span className="text-[10px] text-muted-foreground/30">
          Agent watching {url}
        </span>
      </div>
    </div>
  )
}

function BrowserWireframe() {
  return (
    <div className="w-full max-w-[260px] space-y-3 p-4">
      <div className="flex items-center justify-between">
        <div className="h-2 w-16 rounded-full bg-foreground/[0.08]" />
        <div className="flex gap-2">
          <div className="h-2 w-8 rounded-full bg-foreground/[0.06]" />
          <div className="h-2 w-8 rounded-full bg-foreground/[0.06]" />
        </div>
      </div>
      <div className="space-y-2 py-2">
        <div className="mx-auto h-3 w-36 rounded-full bg-foreground/[0.08]" />
        <div className="mx-auto h-2 w-48 rounded-full bg-foreground/[0.05]" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="space-y-1 rounded-md bg-foreground/[0.03] p-2">
            <div className="h-1.5 w-10 rounded-full bg-foreground/[0.07]" />
            <div className="h-1 w-full rounded-full bg-foreground/[0.04]" />
            <div className="h-1 w-3/4 rounded-full bg-foreground/[0.04]" />
          </div>
        ))}
      </div>
    </div>
  )
}
