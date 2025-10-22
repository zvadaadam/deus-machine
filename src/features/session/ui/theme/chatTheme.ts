/**
 * Chat Theme System
 *
 * Centralized theme tokens for consistent styling across chat components.
 * All colors use Tailwind theme tokens - never hardcode colors!
 */

export const chatTheme = {
  // Message container styles
  message: {
    user: {
      container: 'ml-auto bg-primary/12 border border-primary/20 backdrop-blur-sm w-fit',
      text: 'text-foreground',
      maxWidth: 'max-w-[85%]',
    },
    assistant: {
      container: 'mr-auto',
      text: 'text-foreground',
      maxWidth: 'max-w-full',
    },
  },

  // Content block styles
  blocks: {
    // Tool blocks (tool_use, tool_result)
    tool: {
      container: 'bg-sidebar-accent/30 rounded-md border border-border/40 backdrop-blur-sm',
      header: 'flex items-center gap-1.5 mb-1.5 font-semibold text-xs text-foreground',
      content: 'p-2 rounded font-mono text-xs leading-snug overflow-x-auto whitespace-pre-wrap break-words',
      icon: 'text-sm inline-flex items-center flex-shrink-0',
      borderLeft: {
        default: 'border-l-2 border-l-primary',
        success: 'border-l-2 border-l-success',
        error: 'border-l-2 border-l-destructive',
        info: 'border-l-2 border-l-info',
      },
    },

    // Text blocks
    text: {
      container: 'flex flex-col gap-1.5',
      content: 'm-0 leading-relaxed text-foreground text-base font-sans break-words',
    },

    // Code blocks
    code: {
      container: 'relative group rounded overflow-hidden',
      pre: 'bg-sidebar-accent/40 p-3 rounded overflow-x-auto m-0 font-mono text-sm',
      lineNumbers: 'text-muted-foreground select-none pr-4 border-r border-border/40',
      copyButton: 'absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity duration-200',
    },

    // Diff view
    diff: {
      container: 'grid grid-cols-2 gap-px bg-border/40 rounded overflow-hidden',
      header: 'px-3 py-2 font-semibold text-sm border-b border-border/40',
      content: 'p-3 max-h-[300px] overflow-y-auto font-mono text-xs scrollbar-vibrancy',
      added: {
        header: 'bg-success/10 text-success',
        content: 'bg-success/10 text-success-foreground',
        highlight: 'bg-success/20',
      },
      removed: {
        header: 'bg-destructive/10 text-destructive',
        content: 'bg-destructive/10 text-destructive-foreground',
        highlight: 'bg-destructive/20',
      },
    },

    // Thinking blocks
    thinking: {
      container: 'bg-muted/30 border border-border/40 rounded-lg p-3 backdrop-blur-sm',
      header: 'flex items-center gap-2 text-muted-foreground text-sm font-medium mb-2',
      content: 'text-muted-foreground text-sm italic',
    },
  },

  // Input area styles
  input: {
    container: 'flex-shrink-0 m-0 px-6 pb-4 z-10',
    chatBox: {
      base: 'relative flex items-center gap-3 px-5 py-4 bg-muted/30 backdrop-blur-xl border border-border/50 rounded-[24px] shadow-lg transition-all duration-200 ease-out motion-reduce:transition-none',
      focused: 'border-primary/50 shadow-xl',
      hover: 'hover:border-border',
    },
    field: 'flex-1 bg-transparent border-none outline-none resize-none text-body-lg text-foreground placeholder:text-muted-foreground min-h-[24px] max-h-[200px] font-sans overflow-y-auto scrollbar-vibrancy',
    actions: {
      container: 'flex items-center gap-2 flex-shrink-0',
      button: 'flex items-center gap-2 px-4 py-2 bg-transparent hover:bg-muted/50 border border-border/50 hover:border-border rounded-full text-body-sm text-muted-foreground hover:text-foreground transition-all duration-200 ease disabled:opacity-50 disabled:cursor-not-allowed',
      buttonDestructive: 'flex items-center gap-2 px-4 py-2 bg-destructive/10 hover:bg-destructive/20 border border-destructive/50 hover:border-destructive rounded-full text-body-sm text-destructive-foreground transition-all duration-200 ease',
    },
  },

  // Animation variants
  animations: {
    messageEnter: {
      initial: { opacity: 0, y: 10 },
      animate: { opacity: 1, y: 0 },
      transition: { duration: 0.2, ease: [0.215, 0.61, 0.355, 1] }, // ease-out-cubic
    },
    toolExpand: {
      initial: { height: 0, opacity: 0 },
      animate: { height: 'auto', opacity: 1 },
      exit: { height: 0, opacity: 0 },
      transition: { duration: 0.3, ease: [0.215, 0.61, 0.355, 1] },
    },
    fadeIn: {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      transition: { duration: 0.2 },
    },
  },

  // Spacing
  spacing: {
    messageGap: 'gap-3',
    blockGap: 'gap-2',
    contentGap: 'gap-2',
    // Message margin tokens
    userMessageMargin: 'mb-8',          // 32px spacing below user messages
    assistantTightMargin: 'mb-1',       // 4px spacing for assistant message clusters
  },

  // Common utilities
  common: {
    scrollable: 'overflow-y-auto scrollbar-vibrancy',
    truncate: 'truncate',
    rounded: 'rounded-xl',
    shadow: 'shadow-sm',
    transition: 'transition-colors duration-200 ease-out motion-reduce:transition-none',
  },
} as const;

// Export type for autocomplete
export type ChatTheme = typeof chatTheme;
