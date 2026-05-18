export interface DeusCloudSessionStatus {
  signedIn: boolean;
  accountId: string | null;
  expiresAt: string | null;
  tokenType: "Bearer" | null;
  cloudUrl: string;
}

export interface DeusCloudAuthResult {
  success: boolean;
  session: DeusCloudSessionStatus;
  error?: string;
}
