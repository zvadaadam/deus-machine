/**
 * A composer may now START in the cloud (the window's location). The cloud-access
 * gate's invariant must take that start through its existing path: back to local
 * while the repo's verdict is unknown, then into the cloud once it is a go, or the
 * Grant prompt when access is missing. The hook runs on a minimal hook runtime
 * (useState / useEffect) since the app tests have no DOM renderer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { composerPlace, type Organizations } from "@/features/sidebar/lib/location";

const IN_ACME = { location: "cloud", organizationId: "acme" } as const;
const acme = (ready: boolean): Organizations => ({
  available: ready,
  defaultOrganizationId: "acme",
  items: [{ id: "acme", name: "Acme", role: "owner", ready }],
});
/** Where a composer opened in the window's organization starts. */
const startIn = (ready: boolean) => composerPlace(IN_ACME, acme(ready)).location;

const runtime = vi.hoisted(() => ({
  states: [] as unknown[],
  deps: [] as (unknown[] | undefined)[],
  queue: [] as (() => void)[],
  stateIndex: 0,
  effectIndex: 0,
  dirty: false,
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = runtime.stateIndex++;
    if (!(index in runtime.states)) {
      runtime.states[index] = typeof initial === "function" ? initial() : initial;
    }
    const set = (value: unknown) => {
      const next = typeof value === "function" ? value(runtime.states[index]) : value;
      if (Object.is(next, runtime.states[index])) return;
      runtime.states[index] = next;
      runtime.dirty = true;
    };
    return [runtime.states[index], set];
  },
  useEffect: (effect: () => void, deps?: unknown[]) => {
    const index = runtime.effectIndex++;
    const previous = runtime.deps[index];
    const changed =
      !previous ||
      !deps ||
      deps.length !== previous.length ||
      deps.some((d, i) => !Object.is(d, previous[i]));
    runtime.deps[index] = deps;
    if (changed) runtime.queue.push(effect);
  },
}));

const access = vi.hoisted(() => ({
  status: undefined as string | undefined,
  /** A verdict per organization, where one is given; else `status`. */
  byOrganization: {} as Record<string, string | undefined>,
}));
vi.mock("@/features/repository/ui/composer/useCloudRepoAccess", () => ({
  useCloudRepoAccess: (_repo: string, opts: { organizationId?: string | null }) => {
    const id = opts.organizationId ?? "";
    const status = id in access.byOrganization ? access.byOrganization[id] : access.status;
    const slug = id ? `deus/app@${id}` : "deus/app";
    return { isError: false, data: status ? { status, slug } : undefined };
  },
}));

const { useCloudAccessGate } = await import("@/features/repository/ui/composer/useCloudAccessGate");

/** A composer owning `location` (and its organization), rendered until it settles. */
function composer(start: "local" | "cloud", startOrganization: string | null = null) {
  let location = start;
  let organizationId = startOrganization;
  const changes: string[] = [];
  const onLocationChange = (next: "local" | "cloud") => {
    changes.push(next);
    if (next !== location) runtime.dirty = true;
    location = next;
  };
  let gate: ReturnType<typeof useCloudAccessGate>;
  const render = () => {
    for (let pass = 0; pass < 20; pass++) {
      runtime.dirty = false;
      runtime.stateIndex = 0;
      runtime.effectIndex = 0;
      runtime.queue = [];
      gate = useCloudAccessGate({
        repoId: "repo",
        organizationId,
        signedIn: true,
        location,
        onLocationChange,
      });
      for (const effect of runtime.queue) effect();
      if (!runtime.dirty) return;
    }
    throw new Error("the gate never settled");
  };
  render();
  return {
    render,
    changes,
    /** The composer's menu: make `id` its organization and ask for the cloud there. */
    choose(id: string) {
      organizationId = id;
      gate.requestCloud(id);
      render();
    },
    get location() {
      return location;
    },
    get gate() {
      return gate;
    },
  };
}

beforeEach(() => {
  runtime.states = [];
  runtime.deps = [];
  access.status = undefined;
  access.byOrganization = {};
});

describe("a composer that starts in the cloud", () => {
  it("holds local while the verdict loads, then continues into the cloud", () => {
    const view = composer(startIn(true));
    expect(view.location).toBe("local");
    expect(view.gate.grantOpen).toBe(false);

    access.status = "ok";
    view.render();
    expect(view.location).toBe("cloud");
    expect(view.changes).toEqual(["local", "cloud"]);

    // Settled: another render with the same verdict changes nothing.
    view.render();
    expect(view.changes).toEqual(["local", "cloud"]);
  });

  it("stays in the cloud at once when the verdict is already known to be a go", () => {
    access.status = "ok";
    const view = composer("cloud");
    expect(view.location).toBe("cloud");
    expect(view.changes).toEqual([]);
  });

  it("asks for access instead when the repo needs a grant", () => {
    const view = composer("cloud");
    access.status = "needs_grant";
    view.render();
    expect(view.location).toBe("local");
    expect(view.gate.grantOpen).toBe(true);
    expect(view.gate.slug).toBe("deus/app");
  });

  it("never starts in the cloud when the window's organization is not set up", () => {
    const view = composer(startIn(false));
    expect(view.location).toBe("local");
    expect(view.changes).toEqual([]);
  });
});

describe("choosing an organization in the composer's menu", () => {
  it("turns the cloud on there once that organization's verdict is a go", () => {
    access.byOrganization = { acme: "ok", beta: undefined };
    const view = composer("local", "acme");
    view.choose("beta");
    // Held: Beta's verdict is not known yet, so nothing is created in the cloud early.
    expect(view.location).toBe("local");
    access.byOrganization.beta = "ok";
    view.render();
    expect(view.location).toBe("cloud");
    expect(view.changes).toEqual(["cloud"]);
  });

  it("asks for that organization's access when its repo needs a grant", () => {
    access.byOrganization = { acme: "ok", beta: "needs_grant" };
    const view = composer("local", "acme");
    view.choose("beta");
    expect(view.location).toBe("local");
    expect(view.gate.grantOpen).toBe(true);
    expect(view.gate.slug).toBe("deus/app@beta");
  });

  it("moving from one organization's cloud to another's checks the other again", () => {
    access.byOrganization = { acme: "ok", beta: undefined };
    const view = composer("cloud", "acme");
    expect(view.location).toBe("cloud");
    view.choose("beta");
    expect(view.location).toBe("local");
    access.byOrganization.beta = "unknown";
    view.render();
    expect(view.location).toBe("cloud");
  });
});
