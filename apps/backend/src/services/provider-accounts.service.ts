import type { ProviderAccounts } from "@shared/types/provider-account";
import { getCloudConnectionIdentity, getDeusCloudSessionConfig } from "./agent/cloud/config";
import { AppError } from "../lib/errors";

/** Personal metadata for backend preflights; provider secrets never return to Deus. */
export async function getProviderAccounts(): Promise<ProviderAccounts> {
  const config = getDeusCloudSessionConfig();
  if (!config.deusCloudSessionToken || !config.deusCloudUrl) {
    throw new AppError(401, "Sign in to Deus Cloud to choose a provider account.");
  }
  const identity = getCloudConnectionIdentity();
  const response = await fetch(`${config.deusCloudUrl.replace(/\/$/, "")}/me/provider-accounts`, {
    headers: { authorization: `Bearer ${config.deusCloudSessionToken}` },
    signal: AbortSignal.timeout(15_000),
    redirect: "manual",
  });
  if (!response.ok)
    throw new AppError(
      response.status,
      "Couldn't check your provider accounts. Open Settings → AI Providers and try again."
    );
  const accounts = (await response.json()) as ProviderAccounts;
  if (getCloudConnectionIdentity() !== identity)
    throw new AppError(409, "Your Deus account changed. Try again.");
  return accounts;
}
