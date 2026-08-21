export interface DeusCloudSessionStatus {
  signedIn: boolean;
  accountId: string | null;
  expiresAt: string | null;
  tokenType: "Bearer" | null;
  cloudUrl: string;
  /** This device holds a minted agnt platform key (D1 handshake complete). */
  hasPlatformKey: boolean;
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
