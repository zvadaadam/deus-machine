// agent-server/agents/deus-tools/recording-bridge.ts
// Intercepts browser tool calls and feeds them to the SessionManager's
// camera engine for automatic event snooping.
//
// When a recording is active, every browser tool execution (click, type,
// scroll, navigate, etc.) is automatically logged as a recording event
// with coordinates extracted from the tool result's elementBox.
//
// The agent never calls recording_event — it just uses browser tools
// normally after calling recording_start. The bridge handles everything.

import type { SessionManager } from "../../../../packages/screen-studio/src/mcp/session-manager";
import type { AgentEventType } from "../../../../packages/screen-studio/src/types";
import type { ElementBox } from "./agent-browser-client";

// ============================================================================
// Types
// ============================================================================

/** Structured data passed from browser tool handlers after execution. */
export interface BrowserAction {
  /** The browser tool name (e.g. "BrowserClick", "BrowserType") */
  toolName: string;
  /** Element bounding box (if available from the tool result) */
  elementBox?: ElementBox | null;
  /** Page URL after the action */
  url?: string;
  /** Text typed (for BrowserType) */
  text?: string;
  /** Scroll direction (for BrowserScroll) */
  scrollDirection?: string;
}

// ============================================================================
// Tool name → AgentEventType mapping
// ============================================================================

const TOOL_TO_EVENT_TYPE: Record<string, AgentEventType> = {
  BrowserClick: "click",
  BrowserType: "type",
  BrowserNavigate: "navigate",
  BrowserScroll: "scroll",
  BrowserHover: "click",
  BrowserSelectOption: "click",
  BrowserNavigateBack: "navigate",
  BrowserDragTo: "drag",
  BrowserBatchActions: "click",
};

/** Default viewport center — used for idle events and tools without coordinates. */
const VIEWPORT_CENTER_X = 640;
const VIEWPORT_CENTER_Y = 360;

/** Idle timeout in milliseconds. If no browser action for this long, emit idle event. */
const IDLE_TIMEOUT_MS = 3_000;

// ============================================================================
// RecordingBridge
// ============================================================================

/**
 * Snoops on browser tool executions and feeds events to the recording
 * SessionManager's camera engine.
 *
 * Lifecycle:
 *   1. recording_start → bridge.setActiveSession(recordingSessionId)
 *   2. Browser tools fire → bridge.onBrowserAction(data)
 *   3. recording_stop → bridge.setActiveSession(null)
 *
 * When no active session, all methods are no-ops.
 */
export class RecordingBridge {
  private activeRecordingSessionId: string | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private getSessionManager: () => SessionManager;

  constructor(getSessionManager: () => SessionManager) {
    this.getSessionManager = getSessionManager;
  }

  /**
   * Set the active recording session ID.
   * Called by recording_start (with sessionId) and recording_stop (with null).
   */
  setActiveSession(sessionId: string | null): void {
    this.activeRecordingSessionId = sessionId;
    this.clearIdleTimer();

    if (sessionId) {
      // Start idle monitoring
      this.resetIdleTimer();
    }
  }

  /**
   * Called after each successful browser tool execution.
   * Extracts coordinates and emits a recording event if a session is active.
   */
  onBrowserAction(action: BrowserAction): void {
    if (!this.activeRecordingSessionId) return;

    const eventType = TOOL_TO_EVENT_TYPE[action.toolName];
    if (!eventType) return;

    // Compute coordinates from the element bounding box (center of element)
    // or fall back to viewport center for tools without spatial data.
    let x = VIEWPORT_CENTER_X;
    let y = VIEWPORT_CENTER_Y;

    if (action.elementBox) {
      x = Math.round(action.elementBox.x + action.elementBox.width / 2);
      y = Math.round(action.elementBox.y + action.elementBox.height / 2);
    }

    try {
      const sm = this.getSessionManager();
      sm.event(this.activeRecordingSessionId, eventType, x, y, {
        elementRect: action.elementBox
          ? {
              x: action.elementBox.x,
              y: action.elementBox.y,
              width: action.elementBox.width,
              height: action.elementBox.height,
            }
          : undefined,
        text: action.text,
        url: action.url,
        direction: action.scrollDirection,
      });
    } catch (err) {
      // Don't let recording errors break browser tool execution
      console.warn(`[recording-bridge] Failed to emit event: ${err}`);
    }

    // Reset idle timer after each action
    this.resetIdleTimer();
  }

  /** Whether a recording session is currently active. */
  get isActive(): boolean {
    return this.activeRecordingSessionId !== null;
  }

  /** The current recording session ID, or null. */
  get currentSessionId(): string | null {
    return this.activeRecordingSessionId;
  }

  // --------------------------------------------------------------------------
  // Idle timer management
  // --------------------------------------------------------------------------

  private resetIdleTimer(): void {
    this.clearIdleTimer();

    if (!this.activeRecordingSessionId) return;

    this.idleTimer = setTimeout(() => {
      this.emitIdleEvent();
    }, IDLE_TIMEOUT_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private emitIdleEvent(): void {
    if (!this.activeRecordingSessionId) return;

    try {
      const sm = this.getSessionManager();
      sm.event(this.activeRecordingSessionId, "idle", VIEWPORT_CENTER_X, VIEWPORT_CENTER_Y);
    } catch (err) {
      // Session may have been stopped between timer set and fire
      console.warn(`[recording-bridge] Failed to emit idle event: ${err}`);
    }

    // Restart idle timer so we keep emitting idle events during long pauses
    this.resetIdleTimer();
  }
}
