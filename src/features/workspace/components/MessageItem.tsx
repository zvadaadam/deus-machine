import type { Message } from "../../../types";
import { cn } from "@/lib/utils";

interface MessageItemProps {
  message: Message;
  parseContent: (content: string) => any;
}

export function MessageItem({ message, parseContent }: MessageItemProps) {
  function renderToolUse(toolUse: any, index: number) {
    return (
      <div
        key={`tool-use-${index}`}
        className="bg-sidebar-accent/30 rounded-md p-2 border border-border/40 mt-1 text-[0.85rem] border-l-2 border-l-primary backdrop-blur-sm"
      >
        <div className="flex items-center gap-1.5 mb-1.5 font-semibold text-foreground text-[0.8rem]">
          <span className="text-[0.95rem] inline-flex items-center">🔧</span>
          <strong className="text-[0.8rem] font-semibold">{toolUse.name}</strong>
        </div>
        <pre className="bg-sidebar-accent/40 p-2 rounded font-mono text-xs leading-snug overflow-x-auto m-0 whitespace-pre-wrap break-words text-foreground border-none max-h-[150px] overflow-y-auto scrollbar-vibrancy">
          {JSON.stringify(toolUse.input, null, 2)}
        </pre>
      </div>
    );
  }

  function renderToolResult(toolResult: any, index: number) {
    let content = toolResult.content || "";

    // If content is an array or object, stringify it
    if (typeof content === 'object') {
      content = JSON.stringify(content, null, 2);
    }

    const isError = toolResult.is_error;

    return (
      <div
        key={`tool-result-${index}`}
        className={cn(
          "bg-sidebar-accent/30 rounded-md p-2 border border-border/40 mt-1 text-[0.85rem] border-l-2 backdrop-blur-sm",
          isError ? "border-l-destructive bg-destructive/10" : "border-l-green-500"
        )}
      >
        <div className="flex items-center gap-1.5 mb-1.5 font-semibold text-foreground text-[0.8rem]">
          <span className="text-[0.95rem] inline-flex items-center">{isError ? '❌' : '✅'}</span>
          <strong className="text-[0.8rem] font-semibold">Result</strong>
        </div>
        <pre className={cn(
          "p-2 rounded font-mono text-xs leading-snug overflow-x-auto m-0 whitespace-pre-wrap break-words border-none max-h-[150px] overflow-y-auto scrollbar-vibrancy",
          isError ? "bg-destructive/10 text-destructive" : "bg-sidebar-accent/40 text-foreground"
        )}>
          {content}
        </pre>
      </div>
    );
  }

  function renderText(text: any) {
    const textContent = typeof text === 'string' ? text : (text?.text || '');
    return (
      <div className="flex flex-col gap-1.5">
        <p className="m-0 leading-relaxed text-foreground text-base font-sans break-words">{textContent}</p>
      </div>
    );
  }

  const contentBlocks = parseContent(message.content);
  const isUser = message.role === 'user';
  const isAssistant = message.role === 'assistant';

  return (
    <div
      key={message.id}
      className={cn(
        "max-w-[85%] rounded-xl p-5 flex flex-col gap-3 shadow-sm transition-all duration-200 overflow-hidden backdrop-blur-sm",
        isUser && "ml-auto bg-primary/10 border border-primary/30",
        isAssistant && "mr-auto bg-sidebar-accent/40 border border-border/40"
      )}
    >
      <div className="flex justify-between items-center gap-3 mb-1">
        <span className="font-semibold uppercase text-xs text-muted-foreground tracking-wide">
          {message.role}
        </span>
        <span className="text-[0.7rem] text-muted-foreground/70">
          {new Date(message.created_at).toLocaleTimeString()}
        </span>
      </div>
      <div className="flex flex-col gap-2">
        {Array.isArray(contentBlocks) ? (
          contentBlocks.map((block: any, index: number) => {
            if (!block) return null;

            if (block.type === 'tool_use') {
              return renderToolUse(block, index);
            } else if (block.type === 'tool_result') {
              return renderToolResult(block, index);
            } else if (block.type === 'text' || typeof block === 'string') {
              return <div key={`text-${index}`}>{renderText(block)}</div>;
            } else if (typeof block === 'object') {
              // Handle unknown object types - don't try to render them directly
              console.warn('Unknown block type:', block);
              return null;
            }
            return null;
          })
        ) : (
          <pre>{JSON.stringify(contentBlocks, null, 2)}</pre>
        )}
      </div>
    </div>
  );
}
