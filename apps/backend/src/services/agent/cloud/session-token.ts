import { exchangeCloudSessionToken, SessionTokenExchangeError } from "@shared/cloud-session-token";
import { AppError } from "../../../lib/errors";
import { getCloudConnectionIdentity, type CloudConfig } from "./config";

/** An org API key cannot identify the person whose private subscription should run. */
export async function mintCloudSessionToken(
  providerSessionId: string,
  config: CloudConfig,
  expiresIn: number
): Promise<{ token: string; expiresIn: number }> {
  if (!config.deusCloudSessionToken) {
    throw new AppError(401, "Sign in to Deus Cloud to run cloud agents.");
  }
  const identity = getCloudConnectionIdentity(config);
  if (identity !== getCloudConnectionIdentity()) {
    throw new AppError(
      409,
      "Platform identity changed before token exchange — retry under the new account"
    );
  }
  const result = await exchangeCloudSessionToken({
    baseUrl: config.baseUrl,
    sessionId: providerSessionId,
    bearer: config.deusCloudSessionToken,
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
