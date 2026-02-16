/**
 * Chat Theme System
 *
 * Centralized theme tokens for consistent styling across chat components.
 * All colors use Tailwind theme tokens - never hardcode colors!
 *
 * SPACING SYSTEM DECISION (Phase 2 Architecture Refactor):
 * ========================================================
 * We use a HYBRID approach combining bottom margins with component-level spacing:
 *
 * 1. **Message-level spacing** (Chat.tsx):
 *    - Uses `getMessageSpacingClasses()` to add top/bottom margins
 *    - User messages: `mb-8` (32px gap after)
 *    - Assistant messages: `mb-1` (4px gap between clustered responses)
 *    - Rationale: Allows different spacing between user/assistant turns
 *
 * 2. **Block-level spacing** (MessageItem.tsx):
 *    - Uses `gap-2` on flex container for consistent 8px between blocks
 *    - Rationale: Content blocks should have uniform spacing
 *
 * 3. **Why not pure CSS Grid?**
 *    - Chat messages need ASYMMETRIC spacing (user vs assistant)
 *    - Grid `gap` applies uniform spacing, which doesn't match our UX needs
 *    - Our approach: margin-based for messages, gap-based for blocks
 *
 * 4. **Why not pure margins everywhere?**
 *    - Margin collapsing can cause unexpected behavior
 *    - Hard to reason about when margins stack
 *    - Gap is cleaner for uniform spacing (blocks within messages)
 *
 * 5. **Future refactor considerations:**
 *    - Could use CSS Grid with `row-gap` if we switch to symmetric spacing
 *    - Would need to redesign UX to have uniform message spacing
 *    - Current hybrid approach balances flexibility and maintainability
 */

export const chatTheme = {
  // Message container styles
  message: {
    user: {
      // Maximum Readability: Warm accent background with high-contrast text
      // Jony Ive: "Clarity is not negotiable. If it's meant to be read, make it unambiguously readable."
      container:
        "ml-auto w-fit bg-accent hover:bg-accent/80 backdrop-blur-sm transition-colors duration-200 ease-out motion-reduce:transition-none",
      text: "font-normal",
      textColor: "text-foreground", // Uses semantic foreground color - darkest text in design system
      maxWidth: "max-w-[85%]",
      shape: "rounded-xl", // 12px - tighter than before
      padding: "px-3 py-2", // Tight, dense padding
    },
    assistant: {
      container: "mr-auto",
      text: "text-foreground",
      maxWidth: "max-w-full",
    },
  },

  // User message action buttons (ghost style - positioned absolutely to not affect spacing)
  userActions: {
    container:
      "absolute -bottom-8 right-0 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200",
    button:
      "h-6 px-2 rounded-md flex items-center gap-1.5 hover:bg-muted/40 text-muted-foreground hover:text-foreground transition-all duration-200 ease text-xs",
    buttonActive: "text-success hover:bg-success/10",
    icon: "w-3 h-3",
  },

  // Show more/less for long messages (subtle, not prominent)
  expandToggle: {
    button:
      "text-xs text-muted-foreground hover:text-foreground font-normal mt-2 flex items-center gap-1 transition-colors duration-200",
    icon: "w-3 h-3",
  },

  // Collapse constants for long messages
  collapse: {
    lineHeight: 21, // 14px * 1.5 (text-sm * leading-[1.5])
    maxLines: 8, // Number of lines before collapse
    maxHeight: 168, // 21 * 8 = 168px
    fadeHeight: 48, // h-12 in pixels (3rem = 48px) - subtle fade per user feedback
  },

  // Content block styles
  blocks: {
    // Tool blocks (tool_use, tool_result)
    tool: {
      container: "bg-transparent rounded-md border border-border/40 backdrop-blur-sm",
      header: "flex items-center gap-1.5 font-semibold text-sm text-foreground",
      content:
        "p-2 rounded font-mono text-xs leading-relaxed overflow-x-auto whitespace-pre-wrap break-words",
      icon: "w-4 h-4 inline-flex items-center flex-shrink-0",
      borderLeft: {
        default: "border-l-2 border-l-border",
        primary: "border-l-2 border-l-primary",
        success: "border-l-2 border-l-success",
        error: "border-l-2 border-l-destructive",
        info: "border-l-2 border-l-info",
        warning: "border-l-2 border-l-warning",
      },
      // Content hierarchy for tool outputs (matches Cursor's 12px/11px system)
      contentHierarchy: {
        metadata: "text-xs text-muted-foreground font-normal", // 12px, muted - secondary info
        body: "text-sm text-foreground", // 14px, standard - main content
        emphasis: "text-xs font-normal font-mono text-foreground/80 rounded-sm px-1.5 py-0.5", // 12px, mono - filenames, commands
        mono: "text-xs font-mono text-foreground leading-5", // 12px, mono - terminal/code output (Cursor: 12px, line-height 1.25)
        summary: "text-muted-foreground truncate text-xs", // 12px, muted - collapsed summary text
      },
    },

    // Text blocks (px-2 py-1.5 to align with tool blocks - consistent 6px vertical padding)
    text: {
      container: "flex flex-col gap-1.5 px-2 py-1.5",
      content: "m-0 leading-relaxed text-foreground text-base font-sans break-words",
    },

    // Code blocks
    code: {
      container: "relative group rounded-lg overflow-hidden border border-border/60",
      pre: "bg-muted/70 p-4 rounded-lg overflow-x-auto m-0 font-mono text-sm",
      lineNumbers: "text-muted-foreground select-none pr-4 border-r border-border/40",
      copyButton:
        "absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity duration-200",
    },

    // Diff view
    diff: {
      container: "grid grid-cols-2 gap-px bg-border/40 rounded overflow-hidden",
      header: "px-3 py-2 font-semibold text-sm border-b border-border/40",
      content: "p-3 max-h-[300px] overflow-y-auto font-mono text-xs scrollbar-vibrancy",
      added: {
        header: "bg-success/10 text-success",
        content: "bg-success/10 text-success-foreground",
        highlight: "bg-success/20",
      },
      removed: {
        header: "bg-destructive/10 text-destructive",
        content: "bg-destructive/10 text-destructive-foreground",
        highlight: "bg-destructive/20",
      },
    },

    // Thinking blocks
    thinking: {
      container: "bg-muted/30 border border-border/40 rounded-lg p-3 backdrop-blur-sm",
      header: "flex items-center gap-2 text-muted-foreground text-sm font-medium mb-2",
      content: "text-muted-foreground text-sm italic",
    },
  },

  // Input area styles
  input: {
    container: "flex-shrink-0 m-0 px-6 pb-4 z-10",
    chatBox: {
      base: "relative flex items-center gap-3 px-5 py-4 bg-muted/30 backdrop-blur-xl border border-border/50 rounded-[24px] shadow-lg transition-all duration-200 ease-out motion-reduce:transition-none",
      focused: "border-primary/50 shadow-xl",
      hover: "hover:border-border",
    },
    field:
      "flex-1 bg-transparent border-none outline-none resize-none text-body-lg text-foreground placeholder:text-muted-foreground min-h-[24px] max-h-[200px] font-sans overflow-y-auto scrollbar-vibrancy",
    actions: {
      container: "flex items-center gap-2 flex-shrink-0",
      button:
        "flex items-center gap-2 px-4 py-2 bg-transparent hover:bg-muted/50 border border-border/50 hover:border-border rounded-full text-body-sm text-muted-foreground hover:text-foreground transition-all duration-200 ease disabled:opacity-50 disabled:cursor-not-allowed",
      buttonDestructive:
        "flex items-center gap-2 px-4 py-2 bg-destructive/10 hover:bg-destructive/20 border border-destructive/50 hover:border-destructive rounded-full text-body-sm text-destructive-foreground transition-all duration-200 ease",
    },
  },

  // Animation variants — Framer Motion (co-located in Chat.tsx, ThinkingBlock, ToolUseBlock)
  //   User turn:      150ms ease-out-quad, opacity + x:4px
  //   Assistant turn:  150ms ease-out-quad, opacity only
  //   Working:        200ms ease-out-cubic, opacity + AnimatePresence exit
  // seenMessageIds ref in Chat.tsx prevents re-animation on refetch.
  animations: {
    messageEnter: {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      transition: { duration: 0.15, ease: "ease-out" },
    },
    userEnter: {
      initial: { opacity: 0, x: 4 },
      animate: { opacity: 1, x: 0 },
      transition: { duration: 0.15, ease: "ease-out" },
    },
    toolExpand: {
      initial: { height: 0, opacity: 0 },
      animate: { height: "auto", opacity: 1 },
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
    messageGap: "gap-3",
    blockGap: "gap-2",
    contentGap: "gap-2",
    // Message margin tokens
    userMessageMargin: "mb-8", // 32px spacing below user messages
    assistantTightMargin: "mb-1", // 4px spacing for assistant message clusters
  },

  // Padding tokens - following CLAUDE.md (default 16px for density)
  padding: {
    tight: "p-2", // 8px - tool headers, compact UI elements
    standard: "p-4", // 16px - default padding (CLAUDE.md standard)
    comfortable: "p-6", // 24px - main containers, generous spacing
    // Directional variants
    xTight: "px-2", // 8px horizontal
    xStandard: "px-4", // 16px horizontal
    xComfortable: "px-6", // 24px horizontal
    yTight: "py-2", // 8px vertical
    yStandard: "py-4", // 16px vertical
    yComfortable: "py-6", // 24px vertical
  },

  // Common utilities
  common: {
    scrollable: "overflow-y-auto scrollbar-vibrancy",
    truncate: "truncate",
    rounded: "rounded-xl",
    shadow: "shadow-sm",
    transition: "transition-colors duration-100 ease-in motion-reduce:transition-none",
  },

  // Tool icon theme - semantic colors based on action type
  // Uses colors from global.css for consistency and theme awareness
  tools: {
    // Action-based semantic colors (informational tools)
    Read: "text-info", // Violet - gathering information
    Grep: "text-info", // Violet - searching/reading
    Glob: "text-info", // Violet - finding files
    LS: "text-info", // Violet - listing
    BashOutput: "text-info", // Violet - reading output

    // Creation tools
    Write: "text-success", // Green - creating new content

    // Modification tools
    Edit: "text-warning", // Amber - changing existing content
    MultiEdit: "text-warning", // Amber - multiple changes

    // Execution tools
    Bash: "text-primary", // Copper - running commands
    Task: "text-primary", // Copper - executing tasks

    // Management tools
    TodoWrite: "text-primary", // Copper - task management
    KillShell: "text-destructive", // Red - terminating

    // Network tools
    WebFetch: "text-info", // Violet - fetching data
    WebSearch: "text-info", // Violet - searching

    // Hive MCP — Browser automation
    BrowserSnapshot: "text-info", // Violet - inspecting page
    BrowserNavigate: "text-primary", // Copper - navigation action
    BrowserNavigateBack: "text-primary", // Copper - navigation action
    BrowserClick: "text-warning", // Amber - modifying page state
    BrowserType: "text-warning", // Amber - modifying page state
    BrowserPressKey: "text-warning", // Amber - modifying page state
    BrowserHover: "text-info", // Violet - inspecting
    BrowserSelectOption: "text-warning", // Amber - modifying page state
    BrowserWaitFor: "text-info", // Violet - observing
    BrowserEvaluate: "text-primary", // Copper - executing code
    BrowserConsoleMessages: "text-info", // Violet - reading data
    BrowserScreenshot: "text-info", // Violet - inspecting
    BrowserNetworkRequests: "text-info", // Violet - reading data

    // Hive MCP — Workspace
    AskUserQuestion: "text-primary", // Copper - user interaction
    GetWorkspaceDiff: "text-info", // Violet - reading data
    DiffComment: "text-warning", // Amber - adding content
    GetTerminalOutput: "text-info", // Violet - reading data

    // Size and layout
    iconSize: "h-4 w-4",
    iconBase: "flex-shrink-0",
  },
} as const;

// Export type for autocomplete
export type ChatTheme = typeof chatTheme;
