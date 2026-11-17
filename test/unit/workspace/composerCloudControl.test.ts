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
  heldCloudIntent,
} from "@/features/repository/lib/cloudControl";
import { composerSwitch } from "@/features/sidebar/lib/location";

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

  it("sets up one not set up, makes it the composer's and asks for the cloud there", () => {
    const calls: string[] = [];
    chooseComposerOrganization(
      { id: "gamma", state: "set-up" },
      {
        setUp: (id) => calls.push(`setUp:${id}`),
        setOrganization: (id) => calls.push(`setOrganization:${id}`),
        requestCloud: (id) => calls.push(`requestCloud:${id}`),
      }
    );
    // The setup first, so the gate sees it running when it reads the request.
    expect(calls).toEqual(["setUp:gamma", "setOrganization:gamma", "requestCloud:gamma"]);
  });

  it("does nothing with one setting up, or not set up where it cannot be", () => {
    for (const state of ["setting-up", "unavailable"] as const) {
      const a = actions();
      chooseComposerOrganization({ id: "gamma", state }, a);
      expect(a.setOrganization).not.toHaveBeenCalled();
      expect(a.requestCloud).not.toHaveBeenCalled();
      expect(a.setUp).not.toHaveBeenCalled();
    }
  });
});

describe("the switch is on only where a create would be accepted", () => {
  it("is off in an organization known not to be ready, and stays as it is otherwise", () => {
    expect(composerSwitch("cloud", false)).toBe("local");
    expect(composerSwitch("cloud", true)).toBe("cloud");
    expect(composerSwitch("cloud", undefined)).toBe("cloud");
    expect(composerSwitch("local", true)).toBe("local");
  });

  /**
   * The composer's state as Home holds it: the switch (`composerSwitch` applied as
   * useComposerLocation does), the composer's organization, and the gate's request
   * (`heldCloudIntent` applied as useCloudAccessGate does).
   */
  function composer(ready: Record<string, boolean | undefined>) {
    const state = {
      location: "cloud" as "local" | "cloud",
      organization: "acme",
      request: null as string | null,
      settingUp: false,
    };
    const settle = (status: "ok" | "needs_grant" | undefined = "ok") => {
      const cloudReady = ready[state.organization];
      state.location = composerSwitch(state.location, cloudReady);
      if (state.request === null) return;
      if (state.request !== state.organization) {
        state.request = null;
        return;
      }
      const outcome = heldCloudIntent({
        forRepo: true,
        status: cloudReady ? status : undefined,
        cloudReady,
        settingUp: state.settingUp,
      });
      if (outcome === "go") state.location = "cloud";
      if (outcome !== "hold") state.request = null;
    };
    const setUp = (id: string) =>
      chooseComposerOrganization(
        { id, state: "set-up" },
        {
          setUp: () => (state.settingUp = true),
          setOrganization: (chosen) => (state.organization = chosen),
          requestCloud: (chosen) => (state.request = chosen),
        }
      );
    return { state, settle, setUp, ready };
  }

  it("Set up for Beta while on in Acme: off until Beta is ready, then on in Beta", () => {
    const c = composer({ acme: true, beta: false });
    c.settle();
    expect(c.state).toMatchObject({ location: "cloud", organization: "acme" });
    c.setUp("beta");
    c.settle();
    // A send now creates on this computer, not in a Beta that would refuse it.
    expect(c.state).toMatchObject({ location: "local", organization: "beta", request: "beta" });
    // Beta's keys are pushed (ready) before the setup's own answer.
    c.ready.beta = true;
    c.settle("needs_grant");
    expect(c.state.location).toBe("local");
    c.state.settingUp = false;
    c.settle("ok");
    expect(c.state).toMatchObject({ location: "cloud", organization: "beta", request: null });
  });

  it("Beta never becoming ready leaves it off, and a send creates locally", () => {
    const c = composer({ acme: true, beta: false });
    c.setUp("beta");
    c.settle();
    c.state.settingUp = false;
    c.settle();
    expect(c.state).toMatchObject({ location: "local", organization: "beta", request: null });
    // Beta made ready much later: the request is gone, so nothing turns the cloud on.
    c.ready.beta = true;
    c.settle();
    expect(c.state.location).toBe("local");
  });

  it("a request held while readiness was unknown ends when it arrives as not ready", () => {
    expect(
      heldCloudIntent({ forRepo: true, status: undefined, cloudReady: undefined, settingUp: false })
    ).toBe("hold");
    expect(
      heldCloudIntent({ forRepo: true, status: undefined, cloudReady: false, settingUp: false })
    ).toBe("end");
    expect(
      heldCloudIntent({ forRepo: false, status: undefined, cloudReady: false, settingUp: false })
    ).toBe("end");
    // While a setup runs it waits for it.
    expect(
      heldCloudIntent({ forRepo: true, status: undefined, cloudReady: false, settingUp: true })
    ).toBe("hold");
  });

  it("goes only once ready, and with a project only on a go verdict", () => {
    const ready = { cloudReady: true, settingUp: false };
    expect(heldCloudIntent({ ...ready, forRepo: false, status: undefined })).toBe("go");
    expect(heldCloudIntent({ ...ready, forRepo: true, status: "ok" })).toBe("go");
    expect(heldCloudIntent({ ...ready, forRepo: true, status: "unknown" })).toBe("go");
    expect(heldCloudIntent({ ...ready, forRepo: true, status: "needs_grant" })).toBe("hold");
    expect(heldCloudIntent({ ...ready, forRepo: true, status: undefined })).toBe("hold");
    // A verdict cached from before is not enough where the organization is not ready.
    expect(
      heldCloudIntent({ forRepo: true, status: "ok", cloudReady: undefined, settingUp: false })
    ).toBe("hold");
  });
});
