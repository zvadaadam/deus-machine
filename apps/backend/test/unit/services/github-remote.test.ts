import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const account = vi.hoisted(() => ({
  value: null as null | { deusCloudUrl: string | null; sessionToken: string | null },
}));
vi.mock("../../../src/services/agent/cloud/config", () => ({
  cloudAccount: () => account.value,
}));

import {
  BRANCH_LIST_CAP,
  GITHUB_ANSWER_TTL_MS,
  branches,
  defaultBranch,
  forgetGithubAnswers,
  githubApiUrl,
  isPublicGithubRepo,
  mintRepoInstallationToken,
} from "../../../src/services/github-remote";

type Route = (url: URL, init: RequestInit) => Response | undefined;
let routes: Route[];
const fetchMock = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
  const url = new URL(String(input));
  for (const route of routes) {
    const res = route(url, init);
    if (res) return res;
  }
  return new Response("not found", { status: 404 });
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

function authOf(init: RequestInit): string | undefined {
  return (init.headers as Record<string, string> | undefined)?.authorization;
}

beforeEach(() => {
  process.env.DEUS_GITHUB_API_URL = "http://github.test/api/";
  account.value = { deusCloudUrl: "http://cloud.test", sessionToken: "session" };
  routes = [];
  fetchMock.mockClear();
  forgetGithubAnswers();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  delete process.env.DEUS_GITHUB_API_URL;
  vi.unstubAllGlobals();
});

describe("githubApiUrl", () => {
  it("is GitHub's API unless overridden", () => {
    delete process.env.DEUS_GITHUB_API_URL;
    expect(githubApiUrl("/repos/a/b")).toBe("https://api.github.com/repos/a/b");
    process.env.DEUS_GITHUB_API_URL = "http://github.test/api/";
    expect(githubApiUrl("/repos/a/b")).toBe("http://github.test/api/repos/a/b");
  });
});

describe("defaultBranch", () => {
  it("asks GitHub with the organization's installation token", async () => {
    routes.push((url, init) => {
      if (url.href === "http://cloud.test/orgs/org-1/github/installation-token") {
        expect(JSON.parse(String(init.body))).toEqual({ repository: "acme/rocket" });
        expect(authOf(init)).toBe("Bearer session");
        return json({ token: "ghs_secret" });
      }
      if (url.href === "http://github.test/api/repos/acme/rocket") {
        expect(authOf(init)).toBe("Bearer ghs_secret");
        return json({ default_branch: "trunk" });
      }
    });

    expect(await defaultBranch("acme/rocket", "org-1")).toBe("trunk");
    expect(fetchMock.mock.calls.every(([u]) => !String(u).includes("api.github.com"))).toBe(true);
  });

  it("asks without a token when none can be minted (a public repository)", async () => {
    routes.push((url, init) => {
      if (url.pathname.endsWith("/installation-token")) return json({ message: "no" }, 403);
      if (url.href === "http://github.test/api/repos/acme/open") {
        expect(authOf(init)).toBeUndefined();
        return json({ default_branch: "main" });
      }
    });
    expect(await defaultBranch("acme/open", "org-1")).toBe("main");
  });

  it("does not try to mint without a signed-in organization", async () => {
    account.value = null;
    routes.push((url) => {
      if (url.href === "http://github.test/api/repos/acme/open")
        return json({ default_branch: "x" });
    });
    expect(await defaultBranch("acme/open", null)).toBe("x");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("is null when GitHub will not say", async () => {
    routes.push(() => json({ message: "Not Found" }, 404));
    expect(await defaultBranch("acme/secret", "org-1")).toBeNull();
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    account.value = null;
    expect(await defaultBranch("acme/secret", null)).toBeNull();
  });
});

describe("branches", () => {
  function repoWithBranches(main: string, names: string[]) {
    routes.push((url) => {
      if (url.pathname.endsWith("/installation-token")) return json({ token: "ghs_t" });
      if (url.pathname === "/api/repos/acme/rocket") return json({ default_branch: main });
      if (url.pathname === "/api/repos/acme/rocket/branches") {
        const perPage = Number(url.searchParams.get("per_page"));
        const page = Number(url.searchParams.get("page"));
        return json(names.slice((page - 1) * perPage, page * perPage).map((name) => ({ name })));
      }
    });
  }

  it("lists the default branch first, then the rest, across pages", async () => {
    const names = Array.from({ length: 150 }, (_, i) => `b${i}`);
    names.splice(120, 0, "develop");
    repoWithBranches("develop", names);

    const found = await branches("acme/rocket", "org-1");

    expect(found.defaultBranch).toBe("develop");
    expect(found.branches[0]).toBe("develop");
    expect(found.branches).toHaveLength(151);
    expect(found.branches.filter((n) => n === "develop")).toHaveLength(1);
    expect(found.branches.slice(1, 3)).toEqual(["b0", "b1"]);
    const pages = fetchMock.mock.calls
      .map(([u]) => new URL(String(u)))
      .filter((u) => u.pathname.endsWith("/branches"))
      .map((u) => u.searchParams.get("page"));
    expect(pages).toEqual(["1", "2"]);
  });

  it("stops at the cap", async () => {
    repoWithBranches(
      "main",
      Array.from({ length: 1000 }, (_, i) => `b${i}`)
    );
    const found = await branches("acme/rocket", "org-1");
    expect(found.branches).toHaveLength(BRANCH_LIST_CAP);
    expect(found.branches[0]).toBe("main");
    const pageCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes("/branches"));
    expect(pageCalls.length).toBeLessThanOrEqual(4);
  });

  it("mints once for the default branch and the pages", async () => {
    repoWithBranches("main", ["main", "a"]);
    await branches("acme/rocket", "org-1");
    const mints = fetchMock.mock.calls.filter(([u]) => String(u).includes("installation-token"));
    expect(mints).toHaveLength(1);
  });

  it("is empty when GitHub will not answer", async () => {
    routes.push(() => json({}, 404));
    expect(await branches("acme/secret", "org-1")).toEqual({ defaultBranch: null, branches: [] });
  });
});

describe("one answer per organization and repository", () => {
  const mintCalls = () =>
    fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/installation-token")).length;

  it("is reused by every caller for a short time, a refusal included, and logged once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    routes.push((url) => {
      if (url.pathname.endsWith("/installation-token")) return json({ message: "no" }, 403);
      if (url.pathname === "/api/repos/acme/rocket") return json({ default_branch: "trunk" });
      if (url.pathname.startsWith("/api/repos/acme/rocket/branches")) return json([]);
    });

    // The access gate, the default branch, the branch list, the gate again.
    await mintRepoInstallationToken("https://github.com/acme/rocket", "org-1");
    await defaultBranch("acme/rocket", "org-1");
    await branches("acme/rocket", "org-1");
    await Promise.all([
      mintRepoInstallationToken("git@github.com:acme/rocket.git", "org-1"),
      mintRepoInstallationToken("https://github.com/acme/rocket", "org-1"),
    ]);
    expect(mintCalls()).toBe(1);

    // Another organization is another question.
    await mintRepoInstallationToken("https://github.com/acme/rocket", "org-2");
    expect(mintCalls()).toBe(2);

    // The gate awaiting a grant asks again; the same refusal is not logged again.
    await mintRepoInstallationToken("https://github.com/acme/rocket", "org-1", { fresh: true });
    expect(mintCalls()).toBe(3);
    const logged = warn.mock.calls.filter(([line]) => String(line).includes("acme/rocket"));
    expect(logged).toHaveLength(2); // once for org-1, once for org-2
    warn.mockRestore();
  });

  it("asks again once the answer is old", async () => {
    vi.useFakeTimers();
    try {
      routes.push((url) => {
        if (url.pathname.endsWith("/installation-token")) return json({ token: "ghs_x" });
      });
      await mintRepoInstallationToken("https://github.com/acme/rocket", "org-1");
      vi.advanceTimersByTime(GITHUB_ANSWER_TTL_MS + 1);
      await mintRepoInstallationToken("https://github.com/acme/rocket", "org-1");
      expect(mintCalls()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not keep an answer that was not given (a network failure)", async () => {
    fetchMock.mockImplementationOnce(async () => {
      throw new Error("offline");
    });
    expect(await mintRepoInstallationToken("https://github.com/acme/rocket", "org-1")).toEqual({
      token: null,
      definitive: false,
    });
    routes.push((url) => {
      if (url.pathname.endsWith("/installation-token")) return json({ token: "ghs_x" });
    });
    await Promise.resolve();
    expect(await mintRepoInstallationToken("https://github.com/acme/rocket", "org-1")).toEqual({
      token: "ghs_x",
      definitive: true,
    });
  });

  it("probes whether a repository is public once for a short time", async () => {
    routes.push((url) => {
      if (url.pathname === "/api/repos/acme/private") return new Response(null, { status: 404 });
    });
    expect(await isPublicGithubRepo("acme/private")).toBe(false);
    expect(await isPublicGithubRepo("acme/private")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
