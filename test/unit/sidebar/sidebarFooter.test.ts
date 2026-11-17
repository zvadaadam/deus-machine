import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/features/ai-status/ui/AIStatusIndicator", () => ({ AIStatusIndicator: () => null }));
vi.mock("@/features/connection", () => ({ ConnectionOrb: () => null }));

import { SidebarFooter } from "@/features/sidebar/ui/SidebarFooter";
import { SidebarProvider } from "@/components/ui/sidebar";
import type { AddProjectAction } from "@/features/repository/lib/addProject";

const render = (addActions: AddProjectAction[]) =>
  renderToStaticMarkup(
    createElement(
      SidebarProvider,
      null,
      createElement(SidebarFooter, {
        onAddRepository: vi.fn(),
        onCloneRepository: vi.fn(),
        onStartNewProject: vi.fn(),
        onAddFromGitHub: vi.fn(),
        addActions,
      })
    )
  );

describe("the sidebar's Add project", () => {
  it("is the action itself where there is one way to add (a cloud organization)", () => {
    const html = render(["add-from-github"]);
    expect(html).toContain('aria-label="Add project"');
    expect(html).not.toContain("aria-haspopup");
  });

  it("opens a menu on this computer, where there are several", () => {
    expect(render(["start-new", "clone", "open-local"])).toContain('aria-haspopup="dialog"');
  });
});
