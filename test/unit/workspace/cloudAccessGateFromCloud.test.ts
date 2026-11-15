/**
 * A composer may now START in the cloud (the window's location). The cloud-access
 * gate's invariant must take that start through its existing path: back to local
 * while the repo's verdict is unknown, then into the cloud once it is a go, or the
 * Grant prompt when access is missing. The hook runs on a minimal hook runtime
 * (useState / useEffect) since the app tests have no DOM renderer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { composerLocation } from "@/features/sidebar/lib/location";

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

const access = vi.hoisted(() => ({ status: undefined as string | undefined }));
vi.mock("@/features/repository/ui/composer/useCloudRepoAccess", () => ({
  useCloudRepoAccess: () => ({
    isError: false,
    data: access.status ? { status: access.status, slug: "deus/app" } : undefined,
  }),
}));

const { useCloudAccessGate } = await import("@/features/repository/ui/composer/useCloudAccessGate");

/** A composer owning `location`, rendered until it settles. */
function composer(start: "local" | "cloud") {
  let location = start;
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
      gate = useCloudAccessGate({ repoId: "repo", signedIn: true, location, onLocationChange });
      for (const effect of runtime.queue) effect();
      if (!runtime.dirty) return;
    }
    throw new Error("the gate never settled");
  };
  render();
  return {
    render,
    changes,
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
});

describe("a composer that starts in the cloud", () => {
  it("holds local while the verdict loads, then continues into the cloud", () => {
    const view = composer(composerLocation("cloud", true));
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

  it("never starts in the cloud when Deus Cloud is not signed in", () => {
    const view = composer(composerLocation("cloud", false));
    expect(view.location).toBe("local");
    expect(view.changes).toEqual([]);
  });
});
