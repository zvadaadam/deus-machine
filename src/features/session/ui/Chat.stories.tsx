import { useState, useRef, useCallback } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Upload } from "lucide-react";
import { MessageInput } from "./MessageInput";
import type { MessageInputRef } from "./MessageInput";
import { PastedTextCard } from "./PastedTextCard";
import { PastedImageCard } from "./PastedImageCard";
import { TextBlock } from "./blocks/TextBlock";
import { ThinkingBlock } from "./blocks/ThinkingBlock";

// MessageInput
const inputMeta: Meta<typeof MessageInput> = {
  title: "Chat/MessageInput",
  component: MessageInput,
};
export default inputMeta;

export const Empty: StoryObj<typeof MessageInput> = {
  args: {
    messageInput: "",
    sending: false,
    model: "sonnet",
    thinkingLevel: "NONE",
    onMessageChange: () => {},
    onSend: () => {},
  },
};

export const WithText: StoryObj<typeof MessageInput> = {
  args: {
    messageInput: "Can you help me refactor this component?",
    sending: false,
    model: "sonnet",
    thinkingLevel: "NONE",
    onMessageChange: () => {},
    onSend: () => {},
  },
};

export const Sending: StoryObj<typeof MessageInput> = {
  args: {
    messageInput: "Analyzing the codebase...",
    sending: true,
    sessionStatus: "working",
    model: "sonnet",
    thinkingLevel: "MEDIUM",
    onMessageChange: () => {},
    onSend: () => {},
    onStop: () => {},
  },
};

export const WithThinking: StoryObj<typeof MessageInput> = {
  args: {
    messageInput: "",
    sending: false,
    model: "opus",
    thinkingLevel: "HIGH",
    onMessageChange: () => {},
    onSend: () => {},
  },
};

export const WithContext: StoryObj<typeof MessageInput> = {
  args: {
    messageInput: "",
    sending: false,
    model: "sonnet",
    thinkingLevel: "NONE",
    contextTokenCount: 45000,
    onMessageChange: () => {},
    onSend: () => {},
  },
};

export const WithMCPServers: StoryObj<typeof MessageInput> = {
  args: {
    messageInput: "",
    sending: false,
    model: "sonnet",
    thinkingLevel: "NONE",
    mcpServers: [
      { name: "filesystem", active: true, command: "npx @anthropic/mcp-filesystem" },
      { name: "github", active: true, command: "npx @anthropic/mcp-github" },
      { name: "postgres", active: false, command: "npx @anthropic/mcp-postgres" },
    ],
    onMessageChange: () => {},
    onSend: () => {},
  },
};

export const WithCompactButton: StoryObj<typeof MessageInput> = {
  args: {
    messageInput: "",
    sending: false,
    model: "sonnet",
    thinkingLevel: "NONE",
    showCompactButton: true,
    contextTokenCount: 180000,
    onMessageChange: () => {},
    onSend: () => {},
    onCompact: () => {},
  },
};

// User Message (using TextBlock)
export const UserMessage: StoryObj<typeof TextBlock> = {
  render: (args) => (
    <div className="bg-muted max-w-[85%] rounded-2xl px-4 py-3">
      <TextBlock {...args} />
    </div>
  ),
  args: {
    block: { type: "text", text: "Can you help me refactor this function to be more readable?" },
    role: "user",
  },
};

export const UserMessageLong: StoryObj<typeof TextBlock> = {
  render: (args) => (
    <div className="bg-muted max-w-[85%] rounded-2xl px-4 py-3">
      <TextBlock {...args} />
    </div>
  ),
  args: {
    block: {
      type: "text",
      text: `I'm working on a React application and I have this component that's getting really complex. It has multiple useEffect hooks, lots of state, and the render method is over 200 lines.

Here's what I'm trying to do:
1. Split it into smaller components
2. Extract custom hooks for the data fetching logic
3. Add proper TypeScript types
4. Improve the performance with useMemo/useCallback

Can you help me plan how to approach this refactoring?`,
    },
    role: "user",
  },
};

// Assistant Message (using TextBlock)
export const AssistantMessage: StoryObj<typeof TextBlock> = {
  render: (args) => <TextBlock {...args} />,
  args: {
    block: {
      type: "text",
      text: "I'll help you refactor this component. Let me analyze the code first.",
    },
    role: "assistant",
    weight: "normal",
  },
};

export const AssistantWithCode: StoryObj<typeof TextBlock> = {
  render: (args) => <TextBlock {...args} />,
  args: {
    block: {
      type: "text",
      text: `Here's the refactored version:

\`\`\`typescript
export function useUserData(userId: string) {
  const [data, setData] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchUser(userId).then(setData).finally(() => setLoading(false));
  }, [userId]);

  return { data, loading };
}
\`\`\`

This extracts the data fetching into a reusable hook.`,
    },
    role: "assistant",
    weight: "normal",
  },
};

// Thinking Block
export const Thinking: StoryObj<typeof ThinkingBlock> = {
  render: (args) => <ThinkingBlock {...args} />,
  args: {
    block: {
      type: "thinking",
      thinking:
        "Let me analyze this code. The user wants to refactor a complex component. I should identify the main pain points: multiple useEffects, excessive state, long render method. The best approach would be to extract custom hooks first, then split the component.",
    },
  },
};

// ── Pasted Content Cards ─────────────────────────────────────────────

// PastedTextCard standalone
export const PastedText: StoryObj<typeof PastedTextCard> = {
  render: (args) => (
    <div className="bg-background flex gap-2 p-4">
      <PastedTextCard {...args} />
    </div>
  ),
  args: {
    content: `import { useState, useEffect } from "react";

export function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(handler);
    };
  }, [value, delay]);

  return debouncedValue;
}

// Usage example:
// const debouncedSearch = useDebounce(searchTerm, 300);`,
    onRemove: () => console.log("remove pasted text"),
  },
};

// Multiple pasted text cards
export const MultiplePastedTexts: StoryObj<typeof PastedTextCard> = {
  render: () => (
    <div className="bg-background flex gap-2 overflow-x-auto p-4">
      <PastedTextCard
        content={`function fibonacci(n: number): number {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}

// Test cases
console.log(fibonacci(10)); // 55
console.log(fibonacci(20)); // 6765`}
        onRemove={() => console.log("remove 1")}
      />
      <PastedTextCard
        content={`CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO users (name, email) VALUES
  ('Alice', 'alice@example.com'),
  ('Bob', 'bob@example.com');`}
        onRemove={() => console.log("remove 2")}
      />
      <PastedTextCard
        content={`# Project Setup
1. Clone the repository
2. Install dependencies with npm install
3. Copy .env.example to .env
4. Run database migrations
5. Start the dev server`}
        onRemove={() => console.log("remove 3")}
      />
    </div>
  ),
};

// PastedImageCard standalone
export const PastedImage: StoryObj<typeof PastedImageCard> = {
  render: (args) => (
    <div className="bg-background flex gap-2 p-4">
      <PastedImageCard {...args} />
    </div>
  ),
  args: {
    preview:
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Crect width='200' height='200' fill='%234f46e5'/%3E%3Ctext x='50%25' y='50%25' text-anchor='middle' dy='.3em' fill='white' font-size='16'%3EScreenshot%3C/text%3E%3C/svg%3E",
    fileName: "screenshot.png",
    onRemove: () => console.log("remove image"),
  },
};

// Mixed pasted content (images + text)
export const MixedPastedContent: StoryObj<typeof PastedTextCard> = {
  render: () => (
    <div className="bg-background flex items-start gap-2 overflow-x-auto p-4">
      <PastedImageCard
        preview="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Crect width='200' height='200' fill='%23059669'/%3E%3Ctext x='50%25' y='50%25' text-anchor='middle' dy='.3em' fill='white' font-size='14'%3EUI Mock%3C/text%3E%3C/svg%3E"
        fileName="ui-mock.png"
        onRemove={() => console.log("remove image 1")}
      />
      <PastedImageCard
        preview="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Crect width='200' height='200' fill='%23dc2626'/%3E%3Ctext x='50%25' y='50%25' text-anchor='middle' dy='.3em' fill='white' font-size='14'%3EError%3C/text%3E%3C/svg%3E"
        fileName="error-screenshot.png"
        onRemove={() => console.log("remove image 2")}
      />
      <PastedTextCard
        content={`Error: Cannot find module '@/components/ui/button'
  at Module._resolveFilename (node:internal/modules)
  at Module._load (node:internal/modules/cjs/loader)
  at Module.require (node:internal/modules/cjs/loader)
  at require (node:internal/modules/helpers)

This error occurs when the path alias is not configured correctly in tsconfig.json.
Check that the "paths" field includes the @/* mapping.`}
        onRemove={() => console.log("remove text")}
      />
    </div>
  ),
};

// Functional MessageInput — you can paste text here to test the real behavior
export const Interactive: StoryObj<typeof MessageInput> = {
  render: (args) => {
    const [message, setMessage] = useState("");
    return (
      <div className="bg-background mx-auto w-[600px] pt-40">
        <p className="text-muted-foreground mb-4 text-center text-sm">
          Try pasting 20+ lines of text or an image from your clipboard
        </p>
        <MessageInput
          {...args}
          messageInput={message}
          onMessageChange={setMessage}
          onSend={(content) => {
            console.log("Send:", content);
            setMessage("");
          }}
        />
      </div>
    );
  },
  args: {
    sending: false,
    model: "sonnet",
    thinkingLevel: "NONE",
  },
};

// Drag-and-drop overlay + MessageInput — mirrors SessionPanel's drag handling
export const DragAndDrop: StoryObj<typeof MessageInput> = {
  render: (args) => {
    const [message, setMessage] = useState("");
    const [isDragging, setIsDragging] = useState(false);
    const messageInputRef = useRef<MessageInputRef>(null);

    const handleDragOver = useCallback(
      (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!isDragging) setIsDragging(true);
      },
      [isDragging]
    );

    const handleDragLeave = useCallback((e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = e.currentTarget.getBoundingClientRect();
      if (
        e.clientX < rect.left ||
        e.clientX >= rect.right ||
        e.clientY < rect.top ||
        e.clientY >= rect.bottom
      ) {
        setIsDragging(false);
      }
    }, []);

    const handleDrop = useCallback((e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) {
        messageInputRef.current?.addFiles(files);
      }
    }, []);

    return (
      <div
        className="bg-background border-border/40 relative mx-auto flex h-[500px] w-[700px] flex-col justify-end rounded-xl border"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Drop overlay — appears when dragging files over the area */}
        {isDragging && (
          <div className="animate-drop-overlay-enter absolute inset-0 z-50 flex items-center justify-center rounded-xl bg-black/50 backdrop-blur-sm">
            <div className="border-border/60 bg-muted/80 flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed px-12 py-10 backdrop-blur-md">
              <Upload className="text-muted-foreground h-10 w-10" />
              <p className="text-foreground text-base font-medium">Add files</p>
              <p className="text-muted-foreground text-sm">
                Drop any files here to add them to your message
              </p>
            </div>
          </div>
        )}

        <p className="text-muted-foreground mb-4 text-center text-sm">
          Drag an image file onto this area to test the drop overlay
        </p>

        <MessageInput
          ref={messageInputRef}
          {...args}
          messageInput={message}
          onMessageChange={setMessage}
          onSend={(content) => {
            console.log("Send:", content);
            setMessage("");
          }}
        />
      </div>
    );
  },
  args: {
    sending: false,
    model: "sonnet",
    thinkingLevel: "NONE",
  },
};
