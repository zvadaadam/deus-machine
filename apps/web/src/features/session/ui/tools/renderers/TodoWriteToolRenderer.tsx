import { match } from "ts-pattern";
import { ListChecks, Circle, Loader2, CheckCircle2 } from "lucide-react";
import { BaseToolRenderer } from "../components";
import { cn } from "@/shared/lib/utils";
import type { ToolRendererProps } from "../../chat-types";
import { TOOL_COLORS, TOOL_ICON_CLS } from "../toolColors";

interface Todo {
  content: string;
  activeForm: string;
  status: "pending" | "in_progress" | "completed";
}

const isTodo = (value: unknown): value is Todo => {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as Todo).content === "string" &&
    typeof (value as Todo).activeForm === "string" &&
    ["pending", "in_progress", "completed"].includes((value as Todo).status)
  );
};

export function TodoWriteToolRenderer({ toolUse, toolResult, isLoading }: ToolRendererProps) {
  const todosInput = toolUse.input?.todos;
  const todos: Todo[] = Array.isArray(todosInput) ? todosInput.filter(isTodo) : [];

  // Find current or next task
  const inProgressTask = todos.find((t) => t.status === "in_progress");
  const nextPendingTask = todos.find((t) => t.status === "pending");
  const allCompleted = todos.every((t) => t.status === "completed");

  const currentTaskText = allCompleted
    ? "All tasks completed"
    : inProgressTask?.activeForm || nextPendingTask?.content || "No tasks";

  // Count todos by status
  const statusCounts = todos.reduce(
    (acc, todo) => {
      acc[todo.status] = (acc[todo.status] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  // Status icon and color — single source of truth per status
  const getStatusConfig = (status: Todo["status"]) =>
    match(status)
      .with("completed", () => ({
        icon: <CheckCircle2 className="text-success h-4 w-4" aria-hidden="true" />,
        color: "text-success" as const,
      }))
      .with("in_progress", () => ({
        icon: <Loader2 className="text-info h-4 w-4 animate-spin" aria-hidden="true" />,
        color: "text-info" as const,
      }))
      .with("pending", () => ({
        icon: <Circle className="text-muted-foreground h-4 w-4" aria-hidden="true" />,
        color: "text-muted-foreground" as const,
      }))
      .exhaustive();

  return (
    <BaseToolRenderer
      toolName="Todo"
      icon={<ListChecks className={cn(TOOL_ICON_CLS, TOOL_COLORS.TodoWrite)} />}
      toolUse={toolUse}
      toolResult={toolResult}
      isLoading={isLoading}
      renderSummary={() => (
        <span className="text-muted-foreground truncate text-sm">{currentTaskText}</span>
      )}
      renderContent={() => (
        <div className="space-y-1 px-2 pb-2">
          {todos.map((todo, index) => (
            <div
              key={index}
              className={cn(
                "flex items-start gap-2 rounded-md p-2 transition-colors",
                todo.status === "in_progress" && "bg-info/5 border-info/20 border",
                todo.status === "completed" && "opacity-60"
              )}
            >
              {/* Status icon */}
              <div className="mt-0.5 flex-shrink-0">{getStatusConfig(todo.status).icon}</div>

              {/* Todo content */}
              <div className="min-w-0 flex-1">
                <div
                  className={cn(
                    "text-sm font-medium",
                    todo.status === "completed" && "line-through",
                    getStatusConfig(todo.status).color
                  )}
                >
                  {todo.status === "in_progress" ? todo.activeForm : todo.content}
                </div>

                {/* Show both forms when in progress */}
                {todo.status === "in_progress" && todo.activeForm !== todo.content && (
                  <div className="text-muted-foreground mt-0.5 text-xs italic">{todo.content}</div>
                )}
              </div>

              {/* Status badge */}
              <div
                className={cn(
                  "text-2xs flex-shrink-0 rounded-full px-1.5 py-0.5 font-medium tracking-wide uppercase",
                  todo.status === "completed" && "bg-success/10 text-success",
                  todo.status === "in_progress" && "bg-info/10 text-info",
                  todo.status === "pending" && "bg-muted text-muted-foreground"
                )}
              >
                {todo.status.replace("_", " ")}
              </div>
            </div>
          ))}

          {/* Summary footer */}
          <div className="border-border/50 text-muted-foreground mt-2 flex gap-4 border-t pt-2 text-xs">
            <span>✓ {statusCounts.completed || 0} completed</span>
            <span>⏳ {statusCounts.in_progress || 0} in progress</span>
            <span>○ {statusCounts.pending || 0} pending</span>
          </div>
        </div>
      )}
    />
  );
}
