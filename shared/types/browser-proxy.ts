export type BrowserProxyConsoleLevel = "info" | "warn" | "error" | "debug";

export interface BrowserProxyFrameEvent {
  tabId: string;
  data: string;
  format: "jpeg" | "png";
  width: number;
  height: number;
  timestamp: number;
}

export interface BrowserProxyStateEvent {
  tabId: string;
  currentUrl?: string;
  title?: string;
  loading?: boolean;
  error?: string | null;
}

export interface BrowserProxyConsoleEvent {
  tabId: string;
  level: BrowserProxyConsoleLevel;
  message: string;
}

export interface BrowserProxyErrorEvent {
  tabId: string;
  error: string;
}

export interface BrowserProxyNativeTabRequestEvent {
  tabId: string;
  workspaceId: string;
  url: string;
}

export interface BrowserProxyNativeTabCloseRequestEvent {
  tabId: string;
  workspaceId?: string;
}

export interface BrowserProxyBounds {
  width: number;
  height: number;
}

export interface BrowserProxyAttachParams extends BrowserProxyBounds {
  tabId: string;
  workspaceId?: string;
  url?: string;
  isMobileView?: boolean;
}

export interface BrowserProxyResizeParams extends BrowserProxyBounds {
  tabId: string;
  isMobileView?: boolean;
}

export interface BrowserProxyNavigateParams {
  tabId: string;
  url: string;
}

export interface BrowserProxyTabParams {
  tabId: string;
}

export interface BrowserProxyNativeTabParams {
  tabId: string;
  workspaceId: string;
  url?: string;
}

export type BrowserProxyMouseButton = "none" | "left" | "middle" | "right";

export type BrowserProxyInputParams =
  | {
      tabId: string;
      kind: "mouse";
      type: "mousePressed" | "mouseReleased" | "mouseMoved";
      x: number;
      y: number;
      button: BrowserProxyMouseButton;
      clickCount?: number;
      modifiers?: number;
    }
  | {
      tabId: string;
      kind: "wheel";
      x: number;
      y: number;
      deltaX: number;
      deltaY: number;
      modifiers?: number;
    }
  | {
      tabId: string;
      kind: "key";
      type: "keyDown" | "keyUp";
      key: string;
      code: string;
      text?: string;
      modifiers?: number;
    }
  | {
      tabId: string;
      kind: "touch";
      type: "touchStart" | "touchMove" | "touchEnd" | "touchCancel";
      touchPoints: Array<{ x: number; y: number; id?: number }>;
      modifiers?: number;
    };

export interface BrowserProxyEvalParams {
  tabId: string;
  expression: string;
}

export interface BrowserProxyScreenshotParams {
  tabId: string;
  rect?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}
