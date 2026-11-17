/**
 * The header's location menu says which places are this computer and which are the
 * cloud: a small muted computer or cloud icon after the name (the cloud workspace row's
 * convention), and the same in words in the row's accessible name. The words are an
 * `aria-label`, not hidden text, so the row's visible text stays what it was.
 */
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The menu shows its ⌃ shortcut hints on a Mac only; the rows are checked as a Mac draws
// them, whatever computer runs the test.
beforeAll(() => vi.stubGlobal("navigator", { platform: "MacIntel" }));
afterAll(() => vi.unstubAllGlobals());

vi.mock("@/features/settings/api/auth.queries", () => ({
  useComputerName: () => ({ data: "Studio Mac" }),
}));
vi.mock("@/shared/hooks/useDeusCloudSession", () => ({
  useDeusCloudSession: () => ({ data: undefined }),
}));
vi.mock("@/platform/capabilities", () => ({ capabilities: { isDesktop: true } }));
// The menu's content renders only while open; here every part renders in place.
vi.mock("@/components/ui/dropdown-menu", () => {
  const part =
    (tag: string) =>
    ({ children, asChild, onSelect, align, ...props }: Record<string, unknown>) => {
      void asChild;
      void onSelect;
      void align;
      return createElement(tag, props, children as ReactNode);
    };
  return {
    DropdownMenu: ({ children }: { children: ReactNode }) => children,
    DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
    DropdownMenuContent: part("div"),
    DropdownMenuItem: part("li"),
    DropdownMenuLabel: part("div"),
    DropdownMenuSeparator: part("hr"),
    DropdownMenuShortcut: part("span"),
  };
});

const { SidebarHeader } = await import("@/features/sidebar/ui/SidebarHeader");
const { SidebarProvider } = await import("@/components/ui/sidebar");
type PlaceRow = import("@/features/sidebar/lib/location").PlaceRow;

const LOCAL: PlaceRow = {
  kind: "local",
  key: "local",
  place: { location: "local", organizationId: null },
  shortcut: "⌃1",
};
const ORG: PlaceRow = {
  kind: "organization",
  key: "cloud:beta",
  place: { location: "cloud", organizationId: "beta" },
  name: "Beta Works",
  state: "ready",
  shortcut: "⌃2",
};
const GAMMA: PlaceRow = {
  kind: "organization",
  key: "cloud:gamma",
  place: { location: "cloud", organizationId: "gamma" },
  name: "Gamma",
  state: "unavailable",
  shortcut: "⌃3",
};
const NAMELESS: PlaceRow = {
  kind: "cloud",
  key: "cloud",
  place: { location: "cloud", organizationId: null },
  state: "ready",
  shortcut: "⌃2",
};

/** The header's markup, rendered on the server (these tests run without a DOM). */
function render(rows: PlaceRow[], current: string, isExpanded = true): string {
  return renderToStaticMarkup(
    createElement(
      SidebarProvider,
      null,
      createElement(SidebarHeader, {
        places: { rows, current, location: "local", activity: {}, onChoose: vi.fn() },
        onOpenSettings: vi.fn(),
        onToggleSidebar: vi.fn(),
        isExpanded,
      })
    )
  );
}

const unescape = (text: string) =>
  text
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
/** The menu row (an `li` here) whose markup names `name`. */
const row = (html: string, name: string) =>
  (html.match(/<li\b[^>]*>.*?<\/li>/gs) ?? []).find((item) => unescape(item).includes(name))!;
const trigger = (html: string) =>
  html.match(/<button[^>]*aria-label="[^"]*switch where[^"]*"[^>]*>.*?<\/button>/s)![0];
/** The element's own attribute (its opening tag's). */
const attribute = (element: string, name: string) => {
  const value = element.match(/^<[^>]*>/)![0].match(new RegExp(` ${name}="([^"]*)"`))?.[1];
  return value === undefined ? null : unescape(value);
};
/** The place marks inside an element: each icon's opening tag. */
const marks = (element: string) => element.match(/<svg[^>]*data-slot="place-mark"[^>]*>/g) ?? [];
const text = (element: string) => unescape(element.replace(/<[^>]*>/g, ""));

describe("the location menu's place marks", () => {
  it("marks an organization's row with the cloud, in words for a screen reader", () => {
    const beta = row(render([LOCAL, ORG], "local"), ORG.name);
    expect(marks(beta).map((svg) => attribute(svg, "class"))).toEqual([
      expect.stringContaining("lucide-cloud"),
    ]);
    expect(attribute(marks(beta)[0], "aria-hidden")).toBe("true");
    expect(attribute(beta, "aria-label")).toBe("Beta Works, cloud");
    // The visible text is the name and the shortcut, as before.
    expect(text(beta)).toBe("BBeta Works⌃2");
  });

  it("keeps a row's hint in its words", () => {
    const gamma = row(render([LOCAL, ORG, GAMMA], "local"), GAMMA.name);
    expect(attribute(gamma, "aria-label")).toBe("Gamma, cloud, Not set up");
  });

  it("marks this computer's row with a computer", () => {
    const computer = row(render([LOCAL, ORG], "local"), "Studio Mac");
    expect(marks(computer).map((svg) => attribute(svg, "class"))).toEqual([
      expect.stringContaining("lucide-monitor"),
    ]);
    expect(attribute(computer, "aria-label")).toBe("Studio Mac, this computer");
  });

  it("gives the nameless Deus Cloud row no second cloud", () => {
    const cloud = row(render([LOCAL, NAMELESS], "local"), "Deus Cloud");
    expect(marks(cloud)).toEqual([]);
    expect(attribute(cloud, "aria-label")).toBe("Deus Cloud");
  });

  it("shows the current place's mark on the trigger, and hides it with the name", () => {
    const local = trigger(render([LOCAL, ORG], "local"));
    expect(marks(local).map((svg) => attribute(svg, "class"))).toEqual([
      expect.stringContaining("lucide-monitor"),
    ]);
    expect(attribute(local, "aria-label")).toBe(
      "Studio Mac, this computer, switch where workspaces run"
    );

    const inCloud = trigger(render([LOCAL, ORG], ORG.key));
    expect(marks(inCloud).map((svg) => attribute(svg, "class"))).toEqual([
      expect.stringContaining("lucide-cloud"),
    ]);
    expect(attribute(inCloud, "aria-label")).toBe("Beta Works, cloud, switch where workspaces run");

    expect(marks(trigger(render([LOCAL, NAMELESS], NAMELESS.key)))).toEqual([]);
    expect(marks(trigger(render([LOCAL, ORG], ORG.key, false)))).toEqual([]);
  });
});
