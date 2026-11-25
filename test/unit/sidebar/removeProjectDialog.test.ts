import {
  Children,
  createElement,
  type ComponentProps,
  type PropsWithChildren,
  type ReactElement,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { api } from "@shared/api";
import { CLOUD_PROJECT_REMOVAL_REASON } from "@shared/types/repository";
import { TooltipProvider } from "@/components/ui/tooltip";
import { RemoveProjectDialog } from "@/features/sidebar/ui/RemoveProjectDialog";

const touch = { open: false, button: new EventTarget() };
function show(open: boolean) {
  touch.open = open;
}

// The server renderer has no DOM. Give the real Radix trigger an event target
// and render the portal in place when that trigger opens it.
vi.mock("@/components/ui/dialog", async (original) => {
  const ui = await original<typeof import("@/components/ui/dialog")>();
  function Target({ onClick, ...props }: PropsWithChildren<{ onClick?: EventListener }>) {
    if (onClick) touch.button.addEventListener("click", onClick, { once: true });
    return createElement("button", props);
  }
  return {
    ...ui,
    Dialog: ({ children }: PropsWithChildren) =>
      createElement(ui.Dialog, { open: touch.open, onOpenChange: show }, children),
    DialogTrigger: ({ children, ...props }: ComponentProps<typeof ui.DialogTrigger>) => {
      const button = Children.only(children) as ReactElement<ComponentProps<typeof Target>>;
      return createElement(ui.DialogTrigger, props, createElement(Target, button.props));
    },
    DialogContent: ({ children }: PropsWithChildren) =>
      touch.open ? createElement("section", { role: "dialog" }, children) : null,
  };
});

it("opens the cloud project's refusal on tap and offers only Cancel", async ({
  onTestFinished,
}) => {
  vi.stubGlobal("window", { clearTimeout });
  onTestFinished(() => vi.unstubAllGlobals());
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false } },
  });
  onTestFinished(() => cache.clear());
  await cache.prefetchQuery({
    queryKey: [api.repoRemoval.name, "orbit"],
    queryFn: () => Promise.reject(new Error(CLOUD_PROJECT_REMOVAL_REASON)),
  });
  const dialog = createElement(RemoveProjectDialog, {
    repoId: "orbit",
    name: "Orbit",
    disabledReason: CLOUD_PROJECT_REMOVAL_REASON,
  });
  const render = () =>
    renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: cache },
        createElement(TooltipProvider, null, dialog)
      )
    );

  const closed = render();
  expect(closed).not.toContain('role="dialog"');
  expect(closed).toContain('aria-disabled="true"');
  expect(closed).not.toContain(' disabled=""');
  touch.button.dispatchEvent(new Event("click", { cancelable: true }));
  const opened = render().split('<section role="dialog">')[1];
  expect(opened).toBeDefined();
  expect(opened).toContain(renderToStaticMarkup(CLOUD_PROJECT_REMOVAL_REASON));
  expect(opened).toContain(">Cancel</button>");
  expect(opened).not.toContain(">Remove</button>");
});

it("describes a present or missing folder and keeps Remove available", ({ onTestFinished }) => {
  touch.open = true;
  onTestFinished(() => {
    touch.open = false;
  });
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  const dialog = createElement(
    QueryClientProvider,
    { client },
    createElement(
      TooltipProvider,
      null,
      createElement(RemoveProjectDialog, { repoId: "r", name: "Orbit" })
    )
  );
  for (const [folderExists, text] of [
    [false, "Deus can’t find the project folder at /projects/orbit."],
    [true, "The folder /projects/orbit, its checkouts and its Git branches stay on disk."],
  ] as const) {
    client.setQueryData([api.repoRemoval.name, "r"], {
      rootPath: "/projects/orbit",
      folderExists,
      counts: { archivedWorkspaces: 0, chats: 0, automations: 0 },
    });
    const html = renderToStaticMarkup(dialog);
    expect(html).toContain(text);
    expect(html.includes("stay on disk")).toBe(folderExists);
    expect(html).toContain(">Remove</button>");
  }
  client.clear();
});
