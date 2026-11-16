import { exchangeCloudSessionToken, SessionTokenExchangeError } from "@shared/cloud-session-token";
import { AppError } from "../../../lib/errors";
import { getCloudConnectionIdentity, type CloudAccount } from "./config";

/**
 * An org API key cannot identify the person whose private subscription should
 * run: the token is exchanged with the person's session, so it needs no
 * organization key (a session in an organization not set up here still connects).
 */
export async function mintCloudSessionToken(
  providerSessionId: string,
  account: CloudAccount,
  expiresIn: number
): Promise<{ token: string; expiresIn: number }> {
  if (!account.sessionToken) {
    throw new AppError(401, "Sign in to Deus Cloud to run cloud agents.");
  }
  const identity = getCloudConnectionIdentity();
  const result = await exchangeCloudSessionToken({
    baseUrl: account.baseUrl,
    sessionId: providerSessionId,
    bearer: account.sessionToken,
    expiresIn,
  }).catch((error) => {
    if (error instanceof SessionTokenExchangeError) throw new AppError(error.status, error.message);
    throw error;
  });
  // The token belongs to the identity that started the exchange, including
  // when the renderer requested it through the backed-web token route.
  if (identity !== getCloudConnectionIdentity()) {
    throw new AppError(
      409,
      "Platform identity changed during token exchange — retry under the new account"
    );
  }
  return { token: result.token, expiresIn: result.expiresIn ?? expiresIn };
}
