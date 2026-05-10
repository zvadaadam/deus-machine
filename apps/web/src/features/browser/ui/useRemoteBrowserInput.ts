import { useCallback, useRef } from "react";
import type * as React from "react";
import { sendCommand } from "@/platform/ws/query-protocol-client";
import { FOCUS_URL_BAR_EVENT } from "../types";
import { REMOTE_BROWSER_COMMAND_TIMEOUT_MS } from "./remoteBrowserConstants";
import type { BrowserPoint } from "./browserFrameMediaTransport";

function modifierMask(
  e: Pick<
    KeyboardEvent | React.KeyboardEvent | React.MouseEvent | React.TouchEvent,
    "altKey" | "ctrlKey" | "metaKey" | "shiftKey"
  >
): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

function keyText(e: React.KeyboardEvent): string | undefined {
  if (e.key.length !== 1) return undefined;
  if (e.metaKey || e.ctrlKey) return undefined;
  return e.key;
}

function mouseButton(button: number): "left" | "middle" | "right" | "none" {
  if (button === 0) return "left";
  if (button === 1) return "middle";
  if (button === 2) return "right";
  return "none";
}

interface RemoteBrowserInputHandlers {
  sendMouse: (
    inputType: "mousePressed" | "mouseReleased" | "mouseMoved",
    e: React.MouseEvent<HTMLCanvasElement>
  ) => void;
  sendWheel: (e: React.WheelEvent<HTMLCanvasElement>) => void;
  sendKey: (inputType: "keyDown" | "keyUp", e: React.KeyboardEvent<HTMLCanvasElement>) => void;
  sendTouch: (
    inputType: "touchStart" | "touchMove" | "touchEnd" | "touchCancel",
    e: React.TouchEvent<HTMLCanvasElement>
  ) => void;
}

export function useRemoteBrowserInput(
  tabId: string,
  pointFromClient: (clientX: number, clientY: number) => BrowserPoint
): RemoteBrowserInputHandlers {
  const lastMouseMoveAtRef = useRef(0);

  const canvasPoint = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => pointFromClient(e.clientX, e.clientY),
    [pointFromClient]
  );

  const sendMouse = useCallback(
    (
      inputType: "mousePressed" | "mouseReleased" | "mouseMoved",
      e: React.MouseEvent<HTMLCanvasElement>
    ) => {
      if (inputType === "mouseMoved") {
        const now = Date.now();
        if (now - lastMouseMoveAtRef.current < 33) return;
        lastMouseMoveAtRef.current = now;
      }
      const point = canvasPoint(e);
      sendCommand(
        "browser:input",
        {
          tabId,
          kind: "mouse",
          inputType,
          x: point.x,
          y: point.y,
          button: inputType === "mouseMoved" ? "none" : mouseButton(e.button),
          clickCount: inputType === "mouseMoved" ? 0 : 1,
          modifiers: modifierMask(e),
        },
        REMOTE_BROWSER_COMMAND_TIMEOUT_MS
      ).catch(() => {});
    },
    [canvasPoint, tabId]
  );

  const sendWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      const point = canvasPoint(e);
      sendCommand(
        "browser:input",
        {
          tabId,
          kind: "wheel",
          x: point.x,
          y: point.y,
          deltaX: e.deltaX,
          deltaY: e.deltaY,
          modifiers: modifierMask(e),
        },
        REMOTE_BROWSER_COMMAND_TIMEOUT_MS
      ).catch(() => {});
    },
    [canvasPoint, tabId]
  );

  const sendKey = useCallback(
    (inputType: "keyDown" | "keyUp", e: React.KeyboardEvent<HTMLCanvasElement>) => {
      const isFocusUrl =
        inputType === "keyDown" && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "l";
      if (isFocusUrl) {
        window.dispatchEvent(new CustomEvent(FOCUS_URL_BAR_EVENT));
        e.preventDefault();
        return;
      }
      e.preventDefault();
      sendCommand(
        "browser:input",
        {
          tabId,
          kind: "key",
          inputType,
          key: e.key,
          code: e.code,
          text: keyText(e),
          modifiers: modifierMask(e),
        },
        REMOTE_BROWSER_COMMAND_TIMEOUT_MS
      ).catch(() => {});
    },
    [tabId]
  );

  const sendTouch = useCallback(
    (
      inputType: "touchStart" | "touchMove" | "touchEnd" | "touchCancel",
      e: React.TouchEvent<HTMLCanvasElement>
    ) => {
      e.preventDefault();
      const sourceTouches =
        inputType === "touchEnd" || inputType === "touchCancel" ? [] : Array.from(e.touches);
      sendCommand(
        "browser:input",
        {
          tabId,
          kind: "touch",
          inputType,
          touchPoints: sourceTouches.map((touch) => ({
            id: touch.identifier,
            ...pointFromClient(touch.clientX, touch.clientY),
          })),
          modifiers: modifierMask(e),
        },
        REMOTE_BROWSER_COMMAND_TIMEOUT_MS
      ).catch(() => {});
    },
    [pointFromClient, tabId]
  );

  return { sendMouse, sendWheel, sendKey, sendTouch };
}
