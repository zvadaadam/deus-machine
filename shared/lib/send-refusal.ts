/**
 * A message the cloud platform refused, read for the person.
 *
 * The platform refuses a send with a channel `error` frame whose `code` is
 * `MESSAGE_SEND_FAILED` and whose message is its own `CODE: sentence` (a
 * Durable Object's coded error, e.g. `PROVIDER_ACCOUNT_RECONNECT_REQUIRED:
 * Your default Claude account must be reconnected in Settings → AI Providers,
 * or choose another default.`). The person sees the sentence, never the codes,
 * and a refusal they can act on gets its own category, so it is neither shown
 * nor counted as an internal error.
 *
 * The codes are the platform's (`packages/api/src/schemas/error-codes.ts` in
 * AGNT; the payer refusals come from `secrets/turn-payer.ts`).
 */

/**
 * A turn nobody can pay for: the person's AI provider account is missing or
 * must be reconnected. Its way out is Settings → AI Providers. A product
 * category (the engine's vocabulary admits `_`-prefixed extensions).
 */
export const PROVIDER_ACCOUNT_CATEGORY = "_provider_account";

/** The payer refusals: each clears only in Settings → AI Providers. */
const PROVIDER_ACCOUNT_CODES: ReadonlySet<string> = new Set([
  "PROVIDER_ACCOUNT_RECONNECT_REQUIRED",
  "NO_MODEL_ACCOUNT",
  "NO_PROVIDER_ACCOUNT",
  "COMPANY_MODEL_ACCOUNT_UNAVAILABLE",
]);

const CODE_PREFIX = /^([A-Z][A-Z0-9_]+):\s*/;

export interface SendRefusal {
  /** The innermost code the platform named, when it named one. */
  code: string | null;
  /** The sentence, without the codes in front of it. */
  message: string;
  /** `PROVIDER_ACCOUNT_CATEGORY` for a payer refusal, else `internal`. */
  category: string;
}

/** A channel `error` frame's code and message → what the person is shown. */
export function readSendRefusal(code: unknown, message: unknown): SendRefusal {
  let text = typeof message === "string" ? message.trim() : "";
  let inner: string | null = typeof code === "string" ? code : null;
  for (let found = CODE_PREFIX.exec(text); found; found = CODE_PREFIX.exec(text)) {
    inner = found[1];
    text = text.slice(found[0].length);
  }
  return {
    code: inner,
    message: text || "The cloud could not take this message.",
    category:
      inner !== null && PROVIDER_ACCOUNT_CODES.has(inner) ? PROVIDER_ACCOUNT_CATEGORY : "internal",
  };
}
