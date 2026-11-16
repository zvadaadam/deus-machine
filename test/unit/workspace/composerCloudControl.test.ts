/**
 * The composer's Cloud control: with one organization (or no list) the switch alone,
 * "Cloud"; with several, "Cloud" while off and the organization's name while on, the
 * label a menu of the organizations; choosing one turns the cloud on there.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  chooseComposerOrganization,
  cloudControlWords,
} from "@/features/repository/lib/cloudControl";

vi.mock("@/shared/hooks/useDeusCloudSignIn", () => ({
  useDeusCloudSignIn: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/shared/hooks/useDeusCloudSession", () => ({
  useDeusCloudSession: () => ({ data: undefined }),
}));
vi.mock("@/platform/native/deus-cloud", () => ({ retryProvision: vi.fn() }));
vi.mock("@/features/sidebar/store/sidebarStore", () => ({
  retryCloudSetup: vi.fn(),
  useSidebarStore: (select: (s: { cloudSetupRetrying: boolean }) => unknown) =>
    select({ cloudSetupRetrying: false }),
}));
vi.mock("@/features/repository/ui/composer/useCloudRepoAccess", () => ({
  useCloudRepoAccess: () => ({ isError: false, data: { status: "ok", slug: "deus/app" } }),
}));
vi.mock("@/features/repository/ui/composer/GrantRepositoryAccessModal", () => ({
  GrantRepositoryAccessModal: () => null,
}));
vi.mock("@/features/workspace/ui/BranchSelector", () => ({ BranchSelector: () => null }));

const { CloudToggle } = await import("@/features/repository/ui/composer/ComposerControls");
const { TooltipProvider } = await import("@/components/ui/tooltip");

const ACME = { id: "acme", name: "Acme", ready: true };
const BETA = { id: "beta", name: "Beta Labs", ready: true };

const render = (props: {
  location: "local" | "cloud";
  organization: typeof ACME | null;
  organizations?: (typeof ACME)[];
  withTooltip?: boolean;
}) =>
  renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(CloudToggle, {
        ...props,
        onLocationChange: vi.fn(),
        onOrganizationChange: vi.fn(),
        repoId: "repo",
        cloudReady: true,
      })
    )
  );

describe("the Cloud control", () => {
  it("with one organization is the switch alone: Cloud, no name, no menu", () => {
    for (const location of ["local", "cloud"] as const) {
      const html = render({ location, organization: ACME, organizations: [ACME] });
      expect(html).toContain(">Cloud<");
      expect(html).not.toContain("Acme");
      expect(html).not.toContain("Choose the cloud organization");
      expect(html).toContain('aria-label="Run on a cloud computer"');
    }
  });

  it("with no list is the same", () => {
    const html = render({ location: "cloud", organization: null });
    expect(html).toContain(">Cloud<");
    expect(html).not.toContain("Choose the cloud organization");
  });

  it("with several, off, reads Cloud with a menu and names no organization", () => {
    const html = render({ location: "local", organization: BETA, organizations: [ACME, BETA] });
    expect(html).toContain('aria-label="Choose the cloud organization"');
    expect(html).toContain(">Cloud<");
    expect(html).not.toContain("Beta Labs");
    expect(html).toContain('aria-label="Run on a cloud computer"');
    expect(html).toContain('aria-checked="false"');
  });

  it("with several, on, names the organization it creates in", () => {
    const html = render({ location: "cloud", organization: BETA, organizations: [ACME, BETA] });
    expect(html).toContain('aria-label="Choose the cloud organization"');
    expect(html).toContain(">Beta Labs<");
    expect(html).toContain('aria-label="Run on a cloud computer in Beta Labs"');
    expect(html).toContain('aria-checked="true"');
  });
});

describe("the Cloud control's tooltip", () => {
  /** The opening tag of each element the tooltip is attached to. */
  const triggers = (html: string) => html.match(/<[a-z]+[^>]*data-slot="tooltip-trigger"[^>]*>/g);

  it("with one organization explains the whole label", () => {
    const html = render({ location: "local", organization: ACME, withTooltip: true });
    const found = triggers(html);
    expect(found).toHaveLength(1);
    expect(found![0]).toMatch(/^<label/);
  });

  it("with several is on the switch only, never on the menu trigger it would cover", () => {
    const html = render({
      location: "local",
      organization: ACME,
      organizations: [ACME, BETA],
      withTooltip: true,
    });
    const found = triggers(html);
    expect(found).toHaveLength(1);
    expect(found![0]).toMatch(/^<span/);
    expect(found![0]).not.toContain("Choose the cloud organization");
  });
});

describe("cloudControlWords", () => {
  it("names the organization only with several and the cloud on", () => {
    const words = (several: boolean, location: "local" | "cloud") =>
      cloudControlWords({ several, location, organizationName: "Beta" });
    expect(words(false, "cloud")).toMatchObject({ label: "Cloud", chooser: false });
    expect(words(true, "local")).toMatchObject({
      label: "Cloud",
      chooser: true,
      switchName: "Run on a cloud computer",
      tooltip: "Off — runs in a git worktree on this Mac",
    });
    expect(words(true, "cloud")).toMatchObject({
      label: "Beta",
      chooser: true,
      switchName: "Run on a cloud computer in Beta",
      tooltip: "Runs on a cloud computer in Beta (clones the repo's origin)",
    });
  });
});

describe("choosing an organization in the composer's menu", () => {
  const actions = () => ({ setOrganization: vi.fn(), requestCloud: vi.fn(), setUp: vi.fn() });

  it("makes a ready one the composer's and asks the gate for the cloud there", () => {
    const a = actions();
    chooseComposerOrganization({ id: "beta", state: "ready" }, a);
    expect(a.setOrganization).toHaveBeenCalledWith("beta");
    expect(a.requestCloud).toHaveBeenCalledWith("beta");
    expect(a.setUp).not.toHaveBeenCalled();
  });

  it("never chooses one that is not ready: it sets it up, or does nothing", () => {
    for (const state of ["set-up", "setting-up", "unavailable"] as const) {
      const a = actions();
      chooseComposerOrganization({ id: "gamma", state }, a);
      expect(a.setOrganization).not.toHaveBeenCalled();
      expect(a.requestCloud).not.toHaveBeenCalled();
      expect(a.setUp).toHaveBeenCalledTimes(state === "set-up" ? 1 : 0);
    }
  });
});
