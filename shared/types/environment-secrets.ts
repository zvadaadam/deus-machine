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
  selectedEnvironment: { id: string; setup: SetupStep[]; canEdit: boolean } | null;
  environments: Array<{
    id: string;
    name: string;
    repo: string | null;
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

export interface CloudSecretInput {
  value: string;
  ownerType: "ORG" | "USER";
  appliesToAll: boolean;
  environmentIds: string[];
}

export interface CloudSettingsOrganizations {
  accountId: string;
  currentOrganizationId?: string | null;
  items: Array<{ id: string; name: string; role: string }>;
}
import type { SetupStep } from "@deus-hq/api";
