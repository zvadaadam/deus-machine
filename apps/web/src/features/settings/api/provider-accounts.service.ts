import { toCamelCaseKeys, toSnakeCaseKeys } from "@deus-hq/api";
import type {
  ProviderLogin,
  ProviderLoginOptions,
  ProviderSecretInput,
  ProviderAccount,
  ProviderAccounts,
} from "@shared/types/provider-account";
import { getBaseURL } from "@/shared/config/api.config";
import { getStoredToken, needsRemoteAuth } from "@/features/auth/hooks/useAuth";
import {
  handleWebCloudSessionExpired,
  isCloudDirectWebMode,
  readWebCloudSessionBearer,
  resolveDeusCloudUrl,
} from "@/features/session/cloud/webCloudDirectConfig";

async function request(path: string, init: RequestInit = {}, streaming = false): Promise<Response> {
  const direct = isCloudDirectWebMode();
  const headers = new Headers(init.headers);
  let base: string;
  if (direct) {
    const bearer = await readWebCloudSessionBearer();
    if (!bearer) throw new Error("Sign in to Deus Cloud to manage your provider accounts.");
    headers.set("authorization", `Bearer ${bearer}`);
    base = `${resolveDeusCloudUrl()}/me/provider-accounts`;
  } else {
    base = `${await getBaseURL()}/settings/provider-accounts`;
    if (needsRemoteAuth()) {
      const token = getStoredToken();
      if (token) headers.set("authorization", `Bearer ${token}`);
    }
  }
  const signal = streaming
    ? init.signal
    : AbortSignal.any([AbortSignal.timeout(15_000), ...(init.signal ? [init.signal] : [])]);
  const response = await fetch(`${base}${path}`, { ...init, headers, signal });
  if (!response.ok) {
    if (direct && response.status === 401) handleWebCloudSessionExpired();
    const error = (await response.json().catch(() => null)) as {
      message?: string;
      error?: string;
    } | null;
    throw new Error(
      error?.message ?? error?.error ?? `Provider account request failed (${response.status}).`
    );
  }
  return response;
}

export async function listProviderAccounts(signal?: AbortSignal): Promise<ProviderAccounts> {
  const response = await request("", { signal });
  return toCamelCaseKeys(await response.json());
}

export async function saveProviderAccountSecret(
  input: ProviderSecretInput,
  signal: AbortSignal
): Promise<void> {
  await request("", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(toSnakeCaseKeys(input)),
    signal,
  });
}

export async function startProviderAccountLogin(
  options: ProviderLoginOptions,
  signal: AbortSignal
): Promise<ProviderLogin> {
  const response = await request("/logins", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(toSnakeCaseKeys(options)),
    signal,
  });
  return toCamelCaseKeys(await response.json());
}

export async function cancelProviderAccountLogin(loginId: string): Promise<void> {
  await request(`/logins/${encodeURIComponent(loginId)}`, { method: "DELETE" });
}

export async function updateProviderAccount(
  id: string,
  update: { label?: string; isDefault?: true }
): Promise<void> {
  await request(`/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(toSnakeCaseKeys(update)),
  });
}

export async function disconnectProviderAccount(id: string): Promise<void> {
  await request(`/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** One event stream per pending sign-in, including when the browser returns late. */
export async function waitForProviderAccountLogin(
  loginId: string,
  signal: AbortSignal
): Promise<ProviderAccount> {
  const response = await request(
    `/logins/${encodeURIComponent(loginId)}/events`,
    { headers: { accept: "text/event-stream" }, signal },
    true
  );
  if (!response.body) throw new Error("Sign-in updates are unavailable. Try again.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error("The sign-in connection closed. Try again.");
      buffer += decoder.decode(value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        let event = "";
        const data: string[] = [];
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
        if (event !== "connected" && event !== "error") continue;
        const payload = JSON.parse(data.join("\n"));
        if (event === "error")
          throw new Error(payload.message ?? "Provider sign-in did not complete.");
        return payload.account as ProviderAccount;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
