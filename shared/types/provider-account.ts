export type ProviderId = "claude" | "codex";
export type ProviderAuthMethod = "api_key" | "subscription";

export interface ProviderDefinition {
  id: ProviderId;
  name: string;
  vendor: string;
  authMethods: ProviderAuthMethod[];
  subscriptionName?: string;
  subscriptionInstructions?: string;
  subscriptionTokenSetup?: { command: string; documentationUrl: string };
}

/** Public account metadata. Saved credentials are never returned to clients. */
export interface ProviderAccount {
  id: string;
  provider: ProviderId;
  authMethod: ProviderAuthMethod;
  label: string;
  email: string | null;
  planType: string | null;
  status: "connected" | "reconnect_required";
  isDefault: boolean;
}

export interface ProviderAccounts {
  providers: ProviderDefinition[];
  accounts: ProviderAccount[];
  defaultAccountIds: Partial<Record<ProviderId, string>>;
}

export interface ProviderLogin {
  loginId: string;
  type: "device_code";
  userCode: string;
  verificationUrl: string;
  expiresAt: number;
}

export interface ProviderLoginOptions {
  provider: ProviderId;
  label?: string;
  replaceAccountId?: string;
}

export interface ProviderSecretInput extends ProviderLoginOptions {
  authMethod: ProviderAuthMethod;
  secret: string;
}

export function defaultProviderAccount(
  accounts: ProviderAccounts | undefined,
  provider: ProviderId
) {
  return accounts?.accounts.find(
    (account) =>
      account.provider === provider && account.id === accounts.defaultAccountIds[provider]
  );
}
