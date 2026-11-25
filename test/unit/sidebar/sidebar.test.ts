import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Sidebar, SidebarProvider } from "@/components/ui/sidebar";

it.each([
  [true, "expanded", ""],
  [false, "collapsed", "offcanvas"],
] as const)("keeps the sidebar layout attributes when open is %s", (open, state, collapsible) => {
  const html = renderToStaticMarkup(
    createElement(SidebarProvider, { open }, createElement(Sidebar))
  );
  expect(html).toContain(`data-state="${state}"`);
  expect(html).toContain('data-variant="inset"');
  expect(html).toContain(`data-collapsible="${collapsible}"`);
});
