// This backend's cloud as a live read: kept in memory, read again from the platform
// when credentials arrive or the list is a minute old, and sent to subscribers only
// when it changed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invalidate = vi.hoisted(() => vi.fn());
vi.mock("../../../src/services/query-engine", () => ({ invalidate }));

import {
  getCloudOrganizations,
  getCloudWorkspaceUserId,
  getGithubApp,
  refreshCloudOrganizations,
  resetCloudOrganizationsForTests,
} from "../../../src/services/cloud-settings.service";
import {
  resetCloudConfigForTests,
  setCloudRuntimeCredentials,
} from "../../../src/services/agent/cloud/config";

/** A JWT-shaped session whose subject is `sub` (the identity follows it). */
const session = (sub: string) =>
  `h.${Buffer.from(JSON.stringify({ iss: "deus", sub })).toString("base64url")}.s`;

const LIST = {
  account_id: "alice",
  items: [
    { id: "org_a", name: "Acme", role: "owner" },
    { id: "org_b", name: "Beta", role: "member" },
  ],
};
const fetchMock = vi.fn();
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const pushes = () =>
  invalidate.mock.calls.filter(([names]) => names.includes("cloudOrganizations"));

beforeEach(() => {
  vi.useRealTimers();
  resetCloudConfigForTests();
  resetCloudOrganizationsForTests();
  invalidate.mockReset();
  fetchMock.mockReset().mockImplementation(async () => Response.json(LIST));
  vi.stubGlobal("fetch", fetchMock);
  setCloudRuntimeCredentials({ baseUrl: "https://platform.test", apiKey: null });
});
afterEach(() => {
  vi.useRealTimers();
  resetCloudConfigForTests();
  vi.unstubAllGlobals();
});

/** What the desktop pushes, and what the credentials route does with it. */
async function push(credentials: Parameters<typeof setCloudRuntimeCredentials>[0]) {
  setCloudRuntimeCredentials(credentials);
  refreshCloudOrganizations();
  await settle();
}

describe("cloudOrganizations, the live value", () => {
  it("is nothing at once when signed out with no key, without asking the platform", () => {
    expect(getCloudOrganizations()).toEqual({
      available: false,
      accountId: null,
      defaultOrganizationId: null,
      items: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is available with no items on a developer key and no session", async () => {
    await push({ apiKey: "agnt_sk_dev" });
    expect(getCloudOrganizations()).toEqual({
      available: true,
      accountId: null,
      defaultOrganizationId: null,
      items: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is read from the platform when credentials are pushed, ready by the keys held", async () => {
    await push({ deusCloudSessionToken: session("alice"), orgKeys: { org_b: "key_b" } });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(getCloudOrganizations()).toEqual({
      available: true,
      accountId: "alice",
      defaultOrganizationId: "org_b",
      items: [
        { id: "org_a", name: "Acme", role: "owner", ready: false },
        { id: "org_b", name: "Beta", role: "member", ready: true },
      ],
    });
    expect(pushes().length).toBeGreaterThan(0);
  });

  it("is not available with a session and no key yet; the first listed is the default", async () => {
    await push({ deusCloudSessionToken: session("alice") });
    const value = getCloudOrganizations();
    expect(value.available).toBe(false);
    expect(value.defaultOrganizationId).toBe("org_a");
    expect(value.items.map((org) => org.ready)).toEqual([false, false]);
  });

  it("names the default the desktop pushed, available by another organization's key", async () => {
    await push({
      deusCloudSessionToken: session("alice"),
      orgKeys: { org_b: "key_b" },
      orgId: "org_a",
    });
    expect(getCloudOrganizations()).toMatchObject({
      available: true,
      defaultOrganizationId: "org_a",
      items: [
        { id: "org_a", ready: false },
        { id: "org_b", ready: true },
      ],
    });
  });

  it("does not make every organization ready on a developer key once keys are pushed", async () => {
    await push({
      apiKey: "agnt_sk_dev",
      deusCloudSessionToken: session("alice"),
      orgKeys: { org_b: "key_b" },
    });
    expect(getCloudOrganizations().items).toMatchObject([
      { id: "org_a", ready: false },
      { id: "org_b", ready: true },
    ]);
  });

  it("sends subscribers only a value that changed", async () => {
    await push({ deusCloudSessionToken: session("alice"), orgKeys: { org_a: "key_a" } });
    getCloudOrganizations();
    invalidate.mockClear();
    // The same credentials again (a renewal): read again, nothing changed, nothing sent.
    await push({ deusCloudSessionToken: session("alice"), orgKeys: { org_a: "key_a" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pushes()).toHaveLength(0);
    // A second key arrives: one push, with Beta ready.
    await push({ orgKeys: { org_a: "key_a", org_b: "key_b" } });
    expect(pushes()).toHaveLength(1);
    expect(getCloudOrganizations().items.every((org) => org.ready)).toBe(true);
  });

  it("still sends a change that a read saw first", async () => {
    await push({ deusCloudSessionToken: session("alice"), orgKeys: { org_a: "key_a" } });
    invalidate.mockClear();
    // A key arrives without a publish, and a client reads the new value first.
    setCloudRuntimeCredentials({ orgKeys: { org_a: "key_a", org_b: "key_b" } });
    expect(getCloudOrganizations().items.every((org) => org.ready)).toBe(true);
    // The publish that follows must still reach every other subscriber.
    refreshCloudOrganizations();
    expect(pushes()).toHaveLength(1);
  });

  it("reads a list older than a minute again when it is read, and does not loop", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await push({ deusCloudSessionToken: session("alice"), orgKeys: { org_a: "key_a" } });
    getCloudOrganizations();
    getCloudOrganizations();
    expect(fetchMock).toHaveBeenCalledOnce();
    vi.setSystemTime(Date.now() + 61_000);
    getCloudOrganizations();
    getCloudOrganizations();
    await settle();
    // One read for the two stale reads, and the unchanged answer sends nothing.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    invalidate.mockClear();
    getCloudOrganizations();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pushes()).toHaveLength(0);
  });

  it("keeps the last list when the platform cannot be reached; ready follows the keys", async () => {
    await push({ deusCloudSessionToken: session("alice"), orgKeys: { org_a: "key_a" } });
    fetchMock.mockRejectedValue(new Error("offline"));
    await push({ orgKeys: { org_b: "key_b" } });
    expect(getCloudOrganizations()).toMatchObject({
      available: true,
      defaultOrganizationId: "org_b",
      items: [
        { id: "org_a", ready: false },
        { id: "org_b", ready: true },
      ],
    });
  });

  it("drops the previous person's list at once on an account switch", async () => {
    await push({ deusCloudSessionToken: session("alice"), orgKeys: { org_a: "key_a" } });
    let answer: (response: Response) => void = () => {};
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (answer = resolve)));
    invalidate.mockClear();
    setCloudRuntimeCredentials({ deusCloudSessionToken: session("bob"), orgKeys: {} });
    refreshCloudOrganizations();
    // Before the platform answers for Bob, Alice's organizations are gone.
    expect(getCloudOrganizations()).toEqual({
      available: false,
      accountId: null,
      defaultOrganizationId: null,
      items: [],
    });
    expect(pushes()).toHaveLength(1);
    answer(
      Response.json({ account_id: "bob", items: [{ id: "org_c", name: "C", role: "owner" }] })
    );
    await settle();
    await settle();
    expect(getCloudOrganizations().items.map((org) => org.id)).toEqual(["org_c"]);
  });

  it("keeps the newer list when an older read answers last", async () => {
    const answers: Array<(response: Response) => void> = [];
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => answers.push(resolve)));
    setCloudRuntimeCredentials({
      deusCloudSessionToken: session("alice"),
      orgKeys: { org_a: "a" },
    });
    refreshCloudOrganizations();
    // Credentials pushed again (a key minted): a second read starts while the first is out.
    setCloudRuntimeCredentials({ orgKeys: { org_a: "a", org_c: "c" } });
    refreshCloudOrganizations();
    expect(answers).toHaveLength(2);
    answers[1]!(
      Response.json({
        account_id: "alice",
        items: [...LIST.items, { id: "org_c", name: "Gamma", role: "owner" }],
      })
    );
    await settle();
    await settle();
    answers[0]!(Response.json(LIST));
    await settle();
    await settle();
    expect(getCloudOrganizations().items.map((org) => org.id)).toEqual(["org_a", "org_b", "org_c"]);
  });

  it("is nothing once signed out, sent at once", async () => {
    await push({ deusCloudSessionToken: session("alice"), orgKeys: { org_a: "key_a" } });
    invalidate.mockClear();
    setCloudRuntimeCredentials({ deusCloudSessionToken: null, orgKeys: null });
    refreshCloudOrganizations();
    expect(pushes()).toHaveLength(1);
    expect(getCloudOrganizations()).toEqual({
      available: false,
      accountId: null,
      defaultOrganizationId: null,
      items: [],
    });
  });

  it("shares its read with the membership check", async () => {
    await push({ deusCloudSessionToken: session("alice"), orgKeys: { org_a: "key_a" } });
    expect(await getCloudWorkspaceUserId("org_b")).toBe("alice");
    expect(fetchMock).toHaveBeenCalledOnce();
    // An organization the list lacks is asked about once more before it is refused.
    await expect(getCloudWorkspaceUserId("org_x")).rejects.toThrow("organization changed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("the organization's GitHub App", () => {
  beforeEach(() =>
    setCloudRuntimeCredentials({
      deusCloudUrl: "https://cloud.test",
      deusCloudSessionToken: session("alice"),
    })
  );

  it("reads the installations, then what they reach", async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json({
          installations: [{ github_installation_identifier: 7, account_login: "acme" }],
          app_slug: "deus",
        })
      )
      .mockResolvedValueOnce(Response.json({ repos: ["acme/app"] }));
    expect(await getGithubApp("org_b")).toEqual({
      configured: true,
      signedIn: true,
      installations: [{ installationId: 7, accountLogin: "acme" }],
      appSlug: "deus",
      accessibleRepos: ["acme/app"],
    });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://cloud.test/orgs/org_b/github/installation",
      "https://cloud.test/orgs/org_b/github/accessible-repos",
    ]);
  });

  it.each([503, 404])("is not configured when Deus Cloud answers %s", async (status) => {
    fetchMock.mockResolvedValueOnce(new Response("Unavailable", { status }));
    expect(await getGithubApp("org_b")).toMatchObject({ configured: false, signedIn: true });
  });
});
