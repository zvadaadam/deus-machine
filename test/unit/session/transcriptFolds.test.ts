import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SessionProvider } from "@/features/session/context";
import { useTranscriptFold } from "@/features/session/lib/openChat";

type FoldKind = Parameters<typeof useTranscriptFold>[0];

it("restores an opened row after remount only for the same chat and fold", () => {
  vi.stubGlobal("window", Object.assign(new EventTarget(), { HTMLIFrameElement: class {} }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(Object.assign(new EventTarget(), { nodeType: 9 }) as Document);
  let fold: ReturnType<typeof useTranscriptFold>;
  function Row({ kind, id, defaultOpen }: { kind: FoldKind; id: string; defaultOpen: boolean }) {
    fold = useTranscriptFold(kind, id, defaultOpen);
    return null;
  }
  function mount(sessionId: string, kind: FoldKind, id = "row", defaultOpen = false) {
    act(() =>
      root.render(
        createElement(SessionProvider, {
          sessionId,
          sessionStatus: "idle",
          subagentMessages: new Map(),
          children: createElement(Row, { kind, id, defaultOpen }),
        })
      )
    );
    return fold!;
  }
  try {
    const [, toggle] = mount("first", "activity");
    act(toggle);
    act(() => root.render(null));
    expect(mount("second", "activity")[0]).toBeFalsy();
    expect(mount("first", "worked")[0]).toBeFalsy();
    expect(mount("first", "activity", "after-failure")[0]).toBeFalsy();
    const [open, close] = mount("first", "activity");
    expect(open).toBe(true);
    act(close);
    act(() => root.render(null));
    expect(mount("first", "activity")[0]).toBe(false);
    const [imageOpen, closeImage] = mount("first", "tool", "image", true);
    expect(imageOpen).toBe(true);
    act(closeImage);
    act(() => root.render(null));
    expect(mount("first", "tool", "image", true)[0]).toBe(false);
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
