import type { Meta, StoryObj } from "@storybook/react-vite";
import { BashToolRenderer } from "./BashToolRenderer";
import { EditToolRenderer } from "./EditToolRenderer";
import { WriteToolRenderer } from "./WriteToolRenderer";
import { ReadToolRenderer } from "./ReadToolRenderer";
import { GlobToolRenderer } from "./GlobToolRenderer";
import { GrepToolRenderer } from "./GrepToolRenderer";
import { TaskToolRenderer } from "./TaskToolRenderer";
import { TodoWriteToolRenderer } from "./TodoWriteToolRenderer";
import { WebFetchToolRenderer } from "./WebFetchToolRenderer";
import { WebSearchToolRenderer } from "./WebSearchToolRenderer";
import { MultiEditToolRenderer } from "./MultiEditToolRenderer";
import { DefaultToolRenderer } from "./DefaultToolRenderer";

// Bash
const bashMeta: Meta<typeof BashToolRenderer> = {
  title: "Chat/Tools/Bash",
  component: BashToolRenderer,
};
export default bashMeta;

export const BashSuccess: StoryObj<typeof BashToolRenderer> = {
  args: {
    toolUse: {
      type: "tool_use",
      id: "1",
      name: "Bash",
      input: { command: "npm run build", description: "Build the project" },
    },
    toolResult: {
      type: "tool_result",
      tool_use_id: "1",
      content: "✓ 142 modules transformed.\ndist/index.js 312.45 kB",
    },
  },
};

export const BashError: StoryObj<typeof BashToolRenderer> = {
  args: {
    toolUse: {
      type: "tool_use",
      id: "2",
      name: "Bash",
      input: { command: "npm test" },
    },
    toolResult: {
      type: "tool_result",
      tool_use_id: "2",
      content: "FAIL: Expected 5 but received 3",
      is_error: true,
    },
  },
};

export const BashPending: StoryObj<typeof BashToolRenderer> = {
  args: {
    toolUse: {
      type: "tool_use",
      id: "3",
      name: "Bash",
      input: { command: "npm run dev", description: "Start dev server" },
    },
  },
};

// Edit
export const EditFile: StoryObj<typeof EditToolRenderer> = {
  render: (args) => <EditToolRenderer {...args} />,
  args: {
    toolUse: {
      type: "tool_use",
      id: "4",
      name: "Edit",
      input: {
        file_path: "src/components/Button.tsx",
        old_string: "const Button = () => {\n  return <button>Click</button>\n}",
        new_string: "const Button = ({ label }: Props) => {\n  return <button>{label}</button>\n}",
      },
    },
    toolResult: {
      type: "tool_result",
      tool_use_id: "4",
      content: "File edited successfully",
    },
  },
};

// Write
export const WriteFile: StoryObj<typeof WriteToolRenderer> = {
  render: (args) => <WriteToolRenderer {...args} />,
  args: {
    toolUse: {
      type: "tool_use",
      id: "5",
      name: "Write",
      input: {
        file_path: "src/utils/format.ts",
        content: `export function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
}`,
      },
    },
    toolResult: {
      type: "tool_result",
      tool_use_id: "5",
      content: "File written successfully",
    },
  },
};

// Read
export const ReadFile: StoryObj<typeof ReadToolRenderer> = {
  render: (args) => <ReadToolRenderer {...args} />,
  args: {
    toolUse: {
      type: "tool_use",
      id: "6",
      name: "Read",
      input: { file_path: "package.json" },
    },
    toolResult: {
      type: "tool_result",
      tool_use_id: "6",
      content: `{
  "name": "my-app",
  "version": "1.0.0",
  "dependencies": {
    "react": "^18.3.1"
  }
}`,
    },
  },
};

// Glob
export const GlobFiles: StoryObj<typeof GlobToolRenderer> = {
  render: (args) => <GlobToolRenderer {...args} />,
  args: {
    toolUse: {
      type: "tool_use",
      id: "7",
      name: "Glob",
      input: { pattern: "**/*.tsx", path: "src/components" },
    },
    toolResult: {
      type: "tool_result",
      tool_use_id: "7",
      content: "src/components/Button.tsx\nsrc/components/Input.tsx\nsrc/components/Card.tsx",
    },
  },
};

export const GlobNoResults: StoryObj<typeof GlobToolRenderer> = {
  render: (args) => <GlobToolRenderer {...args} />,
  args: {
    toolUse: {
      type: "tool_use",
      id: "8",
      name: "Glob",
      input: { pattern: "**/*.py" },
    },
    toolResult: {
      type: "tool_result",
      tool_use_id: "8",
      content: "No files found",
    },
  },
};

// Grep
export const GrepSearch: StoryObj<typeof GrepToolRenderer> = {
  render: (args) => <GrepToolRenderer {...args} />,
  args: {
    toolUse: {
      type: "tool_use",
      id: "9",
      name: "Grep",
      input: { pattern: "useState", glob: "*.tsx" },
    },
    toolResult: {
      type: "tool_result",
      tool_use_id: "9",
      content:
        "src/App.tsx:5:  const [count, setCount] = useState(0)\nsrc/hooks/useForm.tsx:3:  const [value, setValue] = useState('')",
    },
  },
};

// Task (Agent)
export const TaskAgent: StoryObj<typeof TaskToolRenderer> = {
  render: (args) => <TaskToolRenderer {...args} />,
  args: {
    toolUse: {
      type: "tool_use",
      id: "10",
      name: "Task",
      input: {
        description: "Explore codebase",
        prompt: "Find all React components that use useState hook",
        subagent_type: "Explore",
      },
    },
    toolResult: {
      type: "tool_result",
      tool_use_id: "10",
      content: "Found 12 components using useState:\n- App.tsx\n- Button.tsx\n- Form.tsx...",
    },
  },
};

// TodoWrite
export const TodoList: StoryObj<typeof TodoWriteToolRenderer> = {
  render: (args) => <TodoWriteToolRenderer {...args} />,
  args: {
    toolUse: {
      type: "tool_use",
      id: "11",
      name: "TodoWrite",
      input: {
        todos: [
          { content: "Set up project", activeForm: "Setting up project", status: "completed" },
          {
            content: "Add authentication",
            activeForm: "Adding authentication",
            status: "in_progress",
          },
          { content: "Write tests", activeForm: "Writing tests", status: "pending" },
          { content: "Deploy to prod", activeForm: "Deploying to prod", status: "pending" },
        ],
      },
    },
    toolResult: {
      type: "tool_result",
      tool_use_id: "11",
      content: "Todos updated",
    },
  },
};

// WebFetch
export const WebFetch: StoryObj<typeof WebFetchToolRenderer> = {
  render: (args) => <WebFetchToolRenderer {...args} />,
  args: {
    toolUse: {
      type: "tool_use",
      id: "12",
      name: "WebFetch",
      input: {
        url: "https://docs.example.com/api",
        prompt: "Extract API endpoints",
      },
    },
    toolResult: {
      type: "tool_result",
      tool_use_id: "12",
      content: "Found 5 endpoints:\n- GET /users\n- POST /users\n- GET /users/:id",
    },
  },
};

// WebSearch
export const WebSearch: StoryObj<typeof WebSearchToolRenderer> = {
  render: (args) => <WebSearchToolRenderer {...args} />,
  args: {
    toolUse: {
      type: "tool_use",
      id: "13",
      name: "WebSearch",
      input: { query: "React 19 new features" },
    },
    toolResult: {
      type: "tool_result",
      tool_use_id: "13",
      content:
        "1. React 19 Release Notes - reactjs.org\n2. What's new in React 19 - blog.example.com",
    },
  },
};

// MultiEdit
export const MultiEdit: StoryObj<typeof MultiEditToolRenderer> = {
  render: (args) => <MultiEditToolRenderer {...args} />,
  args: {
    toolUse: {
      type: "tool_use",
      id: "14",
      name: "MultiEdit",
      input: {
        file_path: "src/config.ts",
        edits: [
          { old_string: "const DEBUG = true", new_string: "const DEBUG = false" },
          {
            old_string: "const API_URL = 'http://localhost'",
            new_string: "const API_URL = 'https://api.prod.com'",
          },
        ],
      },
    },
    toolResult: {
      type: "tool_result",
      tool_use_id: "14",
      content: "Applied 2 edits",
    },
  },
};

// Default (unknown tool)
export const UnknownTool: StoryObj<typeof DefaultToolRenderer> = {
  render: (args) => <DefaultToolRenderer {...args} />,
  args: {
    toolUse: {
      type: "tool_use",
      id: "15",
      name: "CustomMCPTool",
      input: { action: "process", data: { id: 123 } },
    },
    toolResult: {
      type: "tool_result",
      tool_use_id: "15",
      content: "Processed successfully",
    },
  },
};
