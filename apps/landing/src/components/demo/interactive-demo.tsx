import type { ReactNode } from "react";
import { useState, useRef, useEffect } from "react";
import {
  Globe,
  MessageSquare,
  Send,
  Terminal,
  RefreshCw,
  GitCommitHorizontal,
  GitPullRequestArrow,
} from "lucide-react";
import type { Message, Workspace } from "./data";
import { WORKSPACES, getAgentReply } from "./data";

// ─── Main Shell ───────────────────────────────────────────────────────────────

type View = "chat" | "changes" | "browser";

export function InteractiveDemo() {
  const [activeWs, setActiveWs] = useState("auth");
  const [view, setView] = useState<View>("chat");
  const [extraMessages, setExtraMessages] = useState<Record<string, Message[]>>({});
  const [input, setInput] = useState("");
  const [isTyping, setIsTyping] = useState(false);

  const workspace = WORKSPACES.find((w) => w.id === activeWs)!;
  const allMessages = [...workspace.messages, ...(extraMessages[activeWs] ?? [])];

  function switchWorkspace(id: string) {
    setActiveWs(id);
    setView("chat");
  }

  function handleSend() {
    const text = input.trim();
    if (!text || isTyping) return;

    setInput("");
    setExtraMessages((prev) => ({
      ...prev,
      [activeWs]: [...(prev[activeWs] ?? []), { role: "user" as const, content: text }],
    }));

    setIsTyping(true);
    setTimeout(
      () => {
        const reply = getAgentReply(text);
        setExtraMessages((prev) => ({
          ...prev,
          [activeWs]: [
            ...(prev[activeWs] ?? []),
            { role: "assistant" as const, content: reply },
            { role: "cta" as const, content: "" },
          ],
        }));
        setIsTyping(false);
      },
      800 + Math.random() * 600
    );
  }

  const repos = ["deus-machine", "api-server"] as const;
  const byRepo = (repo: string) => WORKSPACES.filter((w) => w.repo === repo);

  return (
    <div className="overflow-hidden rounded-xl bg-[var(--code-surface)]">
      {/* Window chrome */}
      <div className="flex items-center gap-1.5 px-3.5 py-2.5">
        <div className="size-2.5 rounded-full bg-[oklch(0.72_0.19_29)]" />
        <div className="size-2.5 rounded-full bg-[oklch(0.78_0.17_85)]" />
        <div className="size-2.5 rounded-full bg-[oklch(0.72_0.19_145)]" />
        <span className="text-muted-foreground/40 ml-3 text-[11px]">
          Deus Machine — {workspace.name}
        </span>
      </div>

      <div className="flex" style={{ height: 380 }}>
        {/* Sidebar */}
        <div className="bg-foreground/[0.02] hidden w-44 shrink-0 sm:block">
          <div className="p-2.5">
            {repos.map((repo) => (
              <div key={repo} className="mb-3">
                <div className="text-muted-foreground/30 mb-1.5 px-1.5 text-[10px] font-semibold tracking-[0.08em] uppercase">
                  {repo}
                </div>
                {byRepo(repo).map((ws) => (
                  <button
                    key={ws.id}
                    type="button"
                    onClick={() => switchWorkspace(ws.id)}
                    data-active={ws.id === activeWs}
                    className="data-[active=false]:text-muted-foreground/50 data-[active=true]:bg-foreground/[0.06] data-[active=true]:text-foreground/80 data-[active=false]:hover:bg-foreground/[0.03] data-[active=false]:hover:text-muted-foreground/70 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors duration-100 outline-none"
                  >
                    <StatusDot status={ws.status} />
                    <span className="truncate">{ws.name}</span>
                    {ws.time && ws.id === activeWs && (
                      <span className="text-muted-foreground/30 ml-auto text-[10px]">
                        {ws.time}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* Main panel */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Tab bar */}
          <div className="flex items-center gap-1 px-3 py-1.5">
            <ViewTab active={view === "chat"} onClick={() => setView("chat")}>
              <MessageSquare className="size-3" />
              Chat
            </ViewTab>
            <ViewTab active={view === "changes"} onClick={() => setView("changes")}>
              <GitCommitHorizontal className="size-3" />
              Changes
            </ViewTab>
            <ViewTab active={view === "browser"} onClick={() => setView("browser")}>
              <Globe className="size-3" />
              Browser
            </ViewTab>
            <button
              type="button"
              className="ml-auto flex items-center gap-1 rounded-md bg-[var(--status-active)]/15 px-2 py-0.5 text-[10px] font-medium text-[var(--status-active)] transition-colors duration-100 outline-none hover:bg-[var(--status-active)]/25"
            >
              <GitPullRequestArrow className="size-2.5" />
              Merge
            </button>
          </div>

          {/* View content — keyed to force remount on workspace switch */}
          <div key={activeWs} className="flex flex-1 flex-col overflow-hidden">
            {view === "chat" && (
              <ChatView
                messages={allMessages}
                isTyping={isTyping}
                input={input}
                onInputChange={setInput}
                onSend={handleSend}
              />
            )}
            {view === "changes" && <ChangesView workspace={workspace} />}
            {view === "browser" && <BrowserView workspace={workspace} />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Sidebar Status Dot ───────────────────────────────────────────────────────

function StatusDot({ status }: { status: Workspace["status"] }) {
  return (
    <div
      className={`size-2 shrink-0 rounded-full ${
        status === "active"
          ? "bg-[var(--status-active)]"
          : status === "pending"
            ? "bg-[var(--status-pending)]"
            : "bg-[var(--status-idle)]"
      }`}
    />
  );
}

// ─── Tab Button ───────────────────────────────────────────────────────────────

function ViewTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-active={active}
      className="data-[active=false]:text-muted-foreground/35 data-[active=true]:bg-foreground/[0.06] data-[active=true]:text-foreground/70 data-[active=false]:hover:text-muted-foreground/50 flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors duration-100 outline-none"
    >
      {children}
    </button>
  );
}

// ─── Chat View ────────────────────────────────────────────────────────────────

function ChatView({
  messages,
  isTyping,
  input,
  onInputChange,
  onSend,
}: {
  messages: Message[];
  isTyping: boolean;
  input: string;
  onInputChange: (v: string) => void;
  onSend: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length]);

  // Auto-focus the input when the chat view mounts
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="flex flex-1 flex-col overflow-hidden px-3 pb-2.5">
      <div ref={scrollRef} className="flex-1 space-y-1 overflow-y-auto pr-1">
        {messages.map((msg, i) => (
          <ChatMessage key={i} message={msg} />
        ))}
        {isTyping && (
          <div className="flex items-center gap-2 px-2 py-1">
            <div className="border-muted-foreground/20 border-t-muted-foreground/50 size-3 animate-spin rounded-full border" />
            <span className="text-muted-foreground/40 font-mono text-[10px] tabular-nums">
              thinking...
            </span>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="bg-accent mt-2 rounded-2xl shadow-sm">
        <div className="flex items-center gap-2 px-3 py-2.5">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => onInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSend();
            }}
            placeholder="Message agent..."
            className="text-foreground/80 placeholder:text-muted-foreground/30 flex-1 bg-transparent text-[12px] focus:outline-none"
          />
          <button
            type="button"
            onClick={onSend}
            disabled={!input.trim() || isTyping}
            data-ready={!!(input.trim() && !isTyping)}
            className="data-[ready=false]:bg-foreground/10 data-[ready=false]:text-muted-foreground/30 data-[ready=true]:bg-foreground data-[ready=true]:text-background flex size-5 items-center justify-center rounded-full transition-colors duration-100 outline-none"
          >
            <Send className="size-2.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

function ChatMessage({ message }: { message: Message }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end pt-4">
        <div className="bg-accent text-foreground max-w-[85%] rounded-xl px-3 py-2 text-[12px]">
          {message.content}
        </div>
      </div>
    );
  }
  if (message.role === "tool") {
    return (
      <div className="flex items-center gap-2 px-2 py-1 text-[12px] opacity-70">
        <Terminal className="size-3 text-amber-500/70" />
        <span className="text-foreground/60 font-medium">{message.content}</span>
      </div>
    );
  }
  if (message.role === "cta") {
    return (
      <div className="text-foreground/60 px-2 pt-1 text-[12px] leading-relaxed">
        Want to keep going?{" "}
        <a
          href="https://github.com/zvadaadam/deus-machine/releases"
          target="_blank"
          rel="noopener noreferrer"
          className="text-foreground/80 hover:text-foreground underline underline-offset-2 transition-colors"
        >
          Continue in Deus
        </a>
      </div>
    );
  }
  // Assistant
  return (
    <div className="space-y-1 py-1">
      <div className="flex items-center gap-1.5 px-2">
        <img src="/claude-code.svg" alt="" className="size-3.5 rounded-sm opacity-40" />
        <span className="text-muted-foreground/40 text-[10px] font-medium">Claude</span>
      </div>
      <div className="text-foreground/80 px-2 text-[12px] leading-relaxed">{message.content}</div>
    </div>
  );
}

// ─── Changes View ─────────────────────────────────────────────────────────────

function ChangesView({ workspace }: { workspace: Workspace }) {
  if (!workspace.diff) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <span className="text-muted-foreground/30 text-[12px]">No changes yet</span>
      </div>
    );
  }

  const { diff } = workspace;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* File header */}
      <div className="flex items-center gap-2 px-4 py-2">
        <span className="text-foreground/70 font-mono text-[11px]">{diff.file}</span>
        <span className="ml-auto text-[10px] text-[var(--status-active)]">+{diff.add}</span>
        <span className="text-[10px] text-[oklch(0.72_0.19_29)]">-{diff.del}</span>
      </div>

      {/* Diff lines */}
      <div className="flex-1 overflow-y-auto font-mono text-[11px] leading-[1.7]">
        {diff.lines.map((line, i) => (
          <div
            key={i}
            className={`flex ${
              line.type === "add"
                ? "bg-[oklch(0.72_0.18_145/0.08)]"
                : line.type === "del"
                  ? "bg-[oklch(0.72_0.19_29/0.08)]"
                  : ""
            }`}
          >
            <span className="text-muted-foreground/20 w-8 shrink-0 pr-2 text-right select-none">
              {i + 1}
            </span>
            <span
              className={`w-4 shrink-0 text-center select-none ${
                line.type === "add"
                  ? "text-[var(--status-active)]"
                  : line.type === "del"
                    ? "text-[oklch(0.72_0.19_29)]"
                    : "text-transparent"
              }`}
            >
              {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
            </span>
            <span
              className={`flex-1 pr-4 whitespace-pre ${
                line.type === "add"
                  ? "text-[var(--status-active)]"
                  : line.type === "del"
                    ? "text-[oklch(0.72_0.19_29)]"
                    : "text-foreground/50"
              }`}
            >
              {line.content}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Browser View ─────────────────────────────────────────────────────────────

function BrowserView({ workspace }: { workspace: Workspace }) {
  const url = workspace.browserUrl ?? "localhost:1420";

  return (
    <div className="flex flex-1 flex-col overflow-hidden px-3 pb-2.5">
      {/* Browser chrome */}
      <div className="bg-foreground/[0.04] flex items-center gap-2 rounded-t-lg px-3 py-2">
        <div className="flex gap-1">
          <div className="size-2 rounded-full bg-[oklch(0.72_0.19_29)]/50" />
          <div className="size-2 rounded-full bg-[oklch(0.78_0.17_85)]/50" />
          <div className="size-2 rounded-full bg-[oklch(0.72_0.19_145)]/50" />
        </div>
        <div className="bg-foreground/[0.04] flex flex-1 items-center gap-1.5 rounded-md px-2 py-1">
          <Globe className="text-muted-foreground/30 size-2.5" />
          <span className="text-muted-foreground/50 text-[10px]">{url}</span>
        </div>
        <RefreshCw className="text-muted-foreground/25 size-3" />
      </div>

      {/* Browser content — iframe of our own site */}
      <div className="ring-foreground/[0.06] relative flex-1 overflow-hidden rounded-b-lg ring-1 ring-inset">
        <iframe
          src="https://deusmachine.ai"
          title="Browser preview"
          className="h-full w-full border-0"
          sandbox="allow-scripts allow-same-origin"
          loading="lazy"
        />
        {/* Overlay to prevent interaction with iframe */}
        <div className="absolute inset-0" />
      </div>

      {/* Agent watching indicator */}
      <div className="flex items-center justify-center gap-1.5 py-1.5">
        <div className="size-1.5 animate-pulse rounded-full bg-[var(--status-active)]" />
        <span className="text-muted-foreground/30 text-[10px]">Agent watching {url}</span>
      </div>
    </div>
  );
}
