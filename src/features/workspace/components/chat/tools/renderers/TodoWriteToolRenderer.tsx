/**
 * TodoWrite Tool Renderer
 *
 * Specialized renderer for the TodoWrite tool (task tracking)
 * Displays todos with status indicators: pending, in_progress, completed
 */

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronRight, ListChecks, Circle, Loader2, CheckCircle2 } from 'lucide-react';
import { chatTheme } from '../../theme';
import { cn } from '@/lib/utils';
import type { ToolRendererProps } from '../../types';

interface Todo {
  content: string;
  activeForm: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export function TodoWriteToolRenderer({ toolUse, toolResult }: ToolRendererProps) {
  const [isExpanded, setIsExpanded] = useState(true); // Expanded by default for visibility

  const todos: Todo[] = toolUse.input.todos || [];
  const isError = toolResult?.is_error;

  // Count todos by status
  const statusCounts = todos.reduce((acc, todo) => {
    acc[todo.status] = (acc[todo.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  // Get status icon and color
  const getStatusIcon = (status: Todo['status']) => {
    switch (status) {
      case 'completed':
        return <CheckCircle2 className="w-4 h-4 text-success" aria-hidden="true" />;
      case 'in_progress':
        return <Loader2 className="w-4 h-4 text-info animate-spin" aria-hidden="true" />;
      case 'pending':
        return <Circle className="w-4 h-4 text-muted-foreground" aria-hidden="true" />;
    }
  };

  const getStatusColor = (status: Todo['status']) => {
    switch (status) {
      case 'completed':
        return 'text-success';
      case 'in_progress':
        return 'text-info';
      case 'pending':
        return 'text-muted-foreground';
    }
  };

  return (
    <div
      className={cn(
        chatTheme.blocks.tool.container,
        isError
          ? chatTheme.blocks.tool.borderLeft.error + ' bg-destructive/5'
          : 'border-l-4 border-l-purple-500/50 bg-purple-50/30 dark:bg-purple-950/10'
      )}
    >
      {/* Header */}
      <div
        className={cn(
          chatTheme.blocks.tool.header,
          'cursor-pointer hover:bg-muted/50 p-2 rounded transition-colors justify-between'
        )}
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="flex items-center gap-1.5">
          {isExpanded ? (
            <ChevronDown className="w-3 h-3" aria-hidden="true" />
          ) : (
            <ChevronRight className="w-3 h-3" aria-hidden="true" />
          )}
          <ListChecks className="w-4 h-4 text-purple-600 dark:text-purple-400" aria-hidden="true" />
          <strong className="font-semibold">Todo List</strong>

          {/* Summary when collapsed */}
          {!isExpanded && (
            <span className="text-xs text-muted-foreground ml-2">
              {statusCounts.completed || 0}/{todos.length} completed
            </span>
          )}
        </div>

        {/* Result indicator */}
        {toolResult && (
          <span className={isError ? 'text-destructive text-sm' : 'text-success text-sm'}>
            {isError ? '✗ Failed' : '✓ Updated'}
          </span>
        )}
      </div>

      {/* Expandable todo list */}
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
            className="overflow-hidden"
          >
            <div className="space-y-1 px-2 pb-2">
              {todos.map((todo, index) => (
                <div
                  key={index}
                  className={cn(
                    'flex items-start gap-2 p-2 rounded transition-colors',
                    todo.status === 'in_progress' && 'bg-info/5 border border-info/20',
                    todo.status === 'completed' && 'opacity-60'
                  )}
                >
                  {/* Status icon */}
                  <div className="mt-0.5 flex-shrink-0">
                    {getStatusIcon(todo.status)}
                  </div>

                  {/* Todo content */}
                  <div className="flex-1 min-w-0">
                    <div className={cn(
                      'text-sm font-medium',
                      todo.status === 'completed' && 'line-through',
                      getStatusColor(todo.status)
                    )}>
                      {todo.status === 'in_progress' ? todo.activeForm : todo.content}
                    </div>

                    {/* Show both forms when in progress */}
                    {todo.status === 'in_progress' && todo.activeForm !== todo.content && (
                      <div className="text-xs text-muted-foreground mt-0.5 italic">
                        {todo.content}
                      </div>
                    )}
                  </div>

                  {/* Status badge */}
                  <div className={cn(
                    'text-[0.65rem] px-1.5 py-0.5 rounded-full font-medium uppercase tracking-wide flex-shrink-0',
                    todo.status === 'completed' && 'bg-success/10 text-success',
                    todo.status === 'in_progress' && 'bg-info/10 text-info',
                    todo.status === 'pending' && 'bg-muted text-muted-foreground'
                  )}>
                    {todo.status.replace('_', ' ')}
                  </div>
                </div>
              ))}

              {/* Summary footer */}
              <div className="flex gap-4 pt-2 mt-2 border-t border-border/50 text-xs text-muted-foreground">
                <span>✓ {statusCounts.completed || 0} completed</span>
                <span>⏳ {statusCounts.in_progress || 0} in progress</span>
                <span>○ {statusCounts.pending || 0} pending</span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Error display */}
      {isError && toolResult && (
        <div className="p-2 mx-2 mb-2 rounded bg-destructive/10 border border-destructive/30">
          <p className="text-xs text-destructive-foreground font-mono m-0">
            {typeof toolResult.content === 'object'
              ? JSON.stringify(toolResult.content, null, 2)
              : toolResult.content}
          </p>
        </div>
      )}
    </div>
  );
}
