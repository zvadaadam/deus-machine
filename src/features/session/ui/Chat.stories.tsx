import type { Meta, StoryObj } from "@storybook/react-vite";
import { MessageInput } from "./MessageInput";
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
