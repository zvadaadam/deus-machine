/** Application-secret metadata only. Values exist only in the write request. */
export interface EnvironmentSecret {
  id: string;
  name: string;
  ownerType: "ORG" | "USER";
  userId: string | null;
  appliesToAll: boolean;
  environmentIds: string[];
}

export interface CloudEnvironmentSettings {
  accountId: string;
  organizationId: string;
  canManageShared: boolean;
  selectedEnvironment: { id: string; project: ProjectEnvironment | null; canEdit: boolean } | null;
  environments: Array<{
    id: string;
    name: string;
    repo: string | null;
    description: string | null;
    ownerType: "ORG" | "USER";
    isRepositoryDefault: boolean;
  }>;
  secrets: EnvironmentSecret[];
  required: Array<{
    name: string;
    source: "secret" | "configuration" | null;
    secretId: string | null;
  }>;
}

export interface CloudSecretScope {
  ownerType: "ORG" | "USER";
  appliesToAll: boolean;
  environmentIds: string[];
  repo?: string;
}

export interface CloudSecretInput extends CloudSecretScope {
  value: string;
}

export interface CloudSettingsOrganizations {
  accountId: string;
  items: Array<{ id: string; name: string; role: string }>;
}

/**
 * This backend's cloud, as every client of it reads it (`cloudOrganizations`, a
 * live read). `ready`: the backend can act in that organization (it holds the
 * organization's key, or a development fallback key). Signed out with no key:
 * not available, no account and no items.
 */
export interface CloudOrganizations {
  /** This backend can act in the cloud: it holds a key for its default organization
   *  (or a developer key). */
  available: boolean;
  accountId: string | null;
  /** The backend's default organization (where a caller that names none creates), else
   *  the first listed. */
  defaultOrganizationId: string | null;
  items: Array<{ id: string; name: string; role: string; ready: boolean }>;
}
import type { ProjectEnvironment } from "@deus-hq/api";
