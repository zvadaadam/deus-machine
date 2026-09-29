import { createElement, type ComponentProps, type KeyboardEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerInput } from "@/features/session/ui/ComposerInput";
import type { InputGroupButton } from "@/components/ui/input-group";

const state = vi.hoisted(() => ({
  mobile: false,
  textarea: {} as ComponentProps<"textarea">,
  buttons: [] as ComponentProps<typeof InputGroupButton>[],
}));

vi.mock("@/shared/hooks/use-mobile", () => ({ useIsMobile: () => state.mobile }));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return { ...react, useLayoutEffect: react.useEffect };
});
// Capture event handlers while rendering the real shared controls.
vi.mock("@/components/ui/input-group", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/input-group")>();
  return {
    ...actual,
    InputGroupTextarea: (props: ComponentProps<"textarea">) => {
      state.textarea = props;
      return createElement(actual.InputGroupTextarea, props);
    },
    InputGroupButton: (props: ComponentProps<typeof InputGroupButton>) => {
      state.buttons.push(props);
      return createElement(actual.InputGroupButton, props);
    },
  };
});

beforeEach(() => {
  state.mobile = false;
  state.buttons = [];
});

function render(props: Partial<ComponentProps<typeof ComposerInput>> = {}) {
  const onSend = vi.fn();
  const onStop = vi.fn();
  renderToStaticMarkup(
    createElement(ComposerInput, {
      textarea: { value: "Follow up", onChange: vi.fn() },
      hasContent: true,
      sending: false,
      modelControls: null,
      onSend,
      onStop,
      ...props,
    })
  );
  return { onSend, onStop };
}

function pressEnter(overrides: Partial<KeyboardEvent<HTMLTextAreaElement>> = {}) {
  const event = {
    key: "Enter",
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    nativeEvent: { isComposing: false },
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    ...overrides,
  } as KeyboardEvent<HTMLTextAreaElement>;
  state.textarea.onKeyDown!(event);
  return event;
}

describe("shared composer input", () => {
  it("sends on desktop Enter, leaving modified Enter and IME to the textarea", () => {
    const { onSend } = render();
    expect(pressEnter().defaultPrevented).toBe(true);
    expect(onSend).toHaveBeenCalledOnce();
    for (const modifier of [{ shiftKey: true }, { metaKey: true }, { ctrlKey: true }]) {
      expect(pressEnter(modifier).defaultPrevented).toBe(false);
    }
    expect(
      pressEnter({ nativeEvent: { isComposing: true } as globalThis.KeyboardEvent })
        .defaultPrevented
    ).toBe(false);
    expect(onSend).toHaveBeenCalledOnce();
  });

  it("leaves mobile Enter as a newline and sends through the button", () => {
    state.mobile = true;
    const { onSend } = render();
    expect(pressEnter().defaultPrevented).toBe(false);
    expect(onSend).not.toHaveBeenCalled();
    const send = state.buttons.find((button) => button["aria-label"] === "Send message")!;
    send.onClick!({} as never);
    expect(onSend).toHaveBeenCalledOnce();
  });

  it("lets file or skill pickers consume Enter before send", () => {
    const { onSend } = render({ textarea: { onKeyDown: (event) => event.preventDefault() } });
    expect(pressEnter().defaultPrevented).toBe(true);
    expect(onSend).not.toHaveBeenCalled();
  });

  it.each([{ sending: true }, { disabled: true }, { hasContent: false }])(
    "blocks send with %j while keeping Stop available",
    (props) => {
      const { onSend, onStop } = render(props);
      pressEnter();
      const send = state.buttons.find((button) => button["aria-label"] === "Send message")!;
      expect(send.disabled).toBe(true);
      send.onClick!({} as never);
      expect(onSend).not.toHaveBeenCalled();
      const stop = state.buttons.find((button) => button["aria-label"] === "Stop execution")!;
      expect(stop.disabled).not.toBe(true);
      stop.onClick!({} as never);
      expect(onStop).toHaveBeenCalledOnce();
    }
  );
});
