export interface DeusCloudSessionStatus {
  signedIn: boolean;
  accountId: string | null;
  expiresAt: string | null;
  tokenType: "Bearer" | null;
  cloudUrl: string;
  /** This device holds a minted agnt platform key (D1 handshake complete). */
  accountName?: string | null;
  accountEmail?: string | null;
  hasPlatformKey: boolean;
  /**
   * Why this device has no platform key despite being signed in. Provisioning
   * runs AFTER login resolves, so its failure cannot ride the login result —
   * without this the user sees "signed in" plus a cloud lane that silently
   * does nothing, and Settings tells them to sign in when they already are.
   */
  platformKeyError?: string | null;
}

export interface DeusCloudAuthResult {
  success: boolean;
  session: DeusCloudSessionStatus;
  error?: string;
}

export interface ClaudeSubscriptionResult {
  success: boolean;
  hasClaudeSubscription: boolean;
  error?: string;
}

export interface CodexSubscriptionResult {
  success: boolean;
  hasCodexSubscription: boolean;
  accountEmail?: string;
  error?: string;
}
