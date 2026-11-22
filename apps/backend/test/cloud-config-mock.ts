import { ConflictError } from "../src/lib/errors";

/**
 * What a test says the cloud credentials are, in one object: the account
 * (`baseUrl`, `deusCloudUrl`, `deusCloudSessionToken`), the default
 * organization (`orgId`, else the first key's), each organization's key
 * (`orgKeys`), and the developer key (`apiKey`), which serves any organization
 * only while there are no `orgKeys`. Null = signed out with no key.
 */
export interface TestCloudConfig {
  baseUrl: string;
  apiKey?: string | null;
  orgKeys?: Record<string, string>;
  orgId?: string | null;
  deusCloudUrl?: string | null;
  deusCloudSessionToken?: string | null;
}

/**
 * A stand-in for `services/agent/cloud/config` that answers its questions
 * from `read()`, so a test changes the credentials by changing what it returns:
 *
 *   const mockConfig = vi.hoisted(() => vi.fn());
 *   vi.mock("../../../src/services/agent/cloud/config", async () =>
 *     (await import("../../cloud-config-mock")).cloudConfigMock(mockConfig));
 *
 * The identity is the account only, as in the real module.
 */
export function cloudConfigMock(read: () => TestCloudConfig | null | undefined) {
  const current = () => read() ?? null;
  const defaultCloudOrgId = () => {
    const config = current();
    if (!config) return null;
    return config.orgId ?? Object.keys(config.orgKeys ?? {})[0] ?? null;
  };
  const cloudOrg = (orgId?: string | null) => {
    const config = current();
    if (!config) return null;
    const id = orgId ?? defaultCloudOrgId();
    const keyed = Object.keys(config.orgKeys ?? {}).length > 0;
    const apiKey = keyed ? (id ? config.orgKeys?.[id] : undefined) : (config.apiKey ?? null);
    return apiKey ? { orgId: id, baseUrl: config.baseUrl, apiKey } : null;
  };
  const requireCloudOrg = (orgId?: string | null) => {
    const org = cloudOrg(orgId);
    if (!org) throw new ConflictError("This cloud organization is not set up on this computer.");
    return org;
  };
  return {
    cloudAccount: () => {
      const config = current();
      if (!config) return null;
      return {
        baseUrl: config.baseUrl,
        deusCloudUrl: config.deusCloudUrl ?? null,
        sessionToken: config.deusCloudSessionToken ?? null,
        accountId: null,
      };
    },
    cloudOrg,
    cloudOrgOf: (row: { organization_id?: string | null }) => cloudOrg(row.organization_id),
    requireCloudOrg,
    defaultCloudOrgId,
    cloudOrgKeyIds: () => Object.keys(current()?.orgKeys ?? {}),
    getDeusCloudSessionConfig: () => ({
      deusCloudUrl: current()?.deusCloudUrl ?? null,
      deusCloudSessionToken: current()?.deusCloudSessionToken ?? null,
    }),
    getCloudConnectionIdentity: () => {
      const config = current();
      return JSON.stringify([
        config?.baseUrl ?? null,
        config?.deusCloudUrl ?? null,
        config?.deusCloudSessionToken ?? null,
      ]);
    },
    getCloudIdentitySignal: () => new AbortController().signal,
    setCloudConnectHook: () => {},
    runCloudConnectHook: async () => {},
    setCloudIdentityChangedHandler: () => {},
  };
}
