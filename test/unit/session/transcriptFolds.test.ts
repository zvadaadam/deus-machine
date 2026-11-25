import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useTranscriptFold } from "@/features/session/lib/openChat";

type FoldKind = Parameters<typeof useTranscriptFold>[1];

it("restores an opened row after remount only for the same chat and fold", () => {
  vi.stubGlobal("window", Object.assign(new EventTarget(), { HTMLIFrameElement: class {} }));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(Object.assign(new EventTarget(), { nodeType: 9 }) as Document);
  let fold: ReturnType<typeof useTranscriptFold>;
  function Row({ chat, kind, id }: { chat: string; kind: FoldKind; id: string }) {
    fold = useTranscriptFold(chat, kind, id);
    return null;
  }
  function mount(chat: string, kind: FoldKind, id = "row") {
    act(() => root.render(createElement(Row, { chat, kind, id })));
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
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
