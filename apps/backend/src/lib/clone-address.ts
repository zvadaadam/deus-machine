// backend/src/lib/clone-address.ts
// What may be cloned, and where a clone goes by default. One rule for the
// app's "Clone from GitHub" (`gitClone`) and an assistant's `add_project`.
//
// Accepted: a GitHub `owner/name` (cloned from GitHub over https), an
// `https://` address, and an ssh address (`user@host:path` or `ssh://`).
// Everything else is refused before git runs: local paths, `file:`, `ext::`
// and every other transport, plain `http://`, whitespace, control characters
// and anything outside printable ASCII, a leading `-`, and a user name or
// password inside an address. A refusal never repeats the address, so a
// credential in it is not echoed back or logged.

import os from "node:os";
import path from "node:path";
import { httpsOrigin, normalizeRepoRef } from "@shared/git-origin";

export interface CloneAddress {
  /** What git is given (after `--`): `owner/name` becomes GitHub's https address. */
  url: string;
  /** The folder a clone goes into, from the repository's name: safe characters only. */
  name: string;
  /** The repository's identity, as projects' origins are compared (`.git`, case and scheme aside). */
  key: string;
}

export type ParsedCloneAddress =
  | { ok: true; address: CloneAddress }
  | { ok: false; reason: string };

const MAX_LENGTH = 500;
const MAX_NAME = 100;
const HOST = "[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?";
/** One path segment: never begins with `-`, so no part of it reads as an option on the far side. */
const SEGMENT = "[A-Za-z0-9_.][A-Za-z0-9_.-]*";
const PATH = `${SEGMENT}(?:/${SEGMENT})*`;
const USER = "[A-Za-z0-9_][A-Za-z0-9_.-]*";

const OWNER_NAME = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9_.][A-Za-z0-9_.-]*)$/;
const HTTPS = new RegExp(`^https://${HOST}(?::\\d{1,5})?/(${PATH})/?$`);
const SCP = new RegExp(`^${USER}@${HOST}:(${PATH})/?$`);
const SSH = new RegExp(`^ssh://(?:${USER}@)?${HOST}(?::\\d{1,5})?/(${PATH})/?$`);
/** A scheme with something before the host ending at `@`: a user name, a token or a password. */
const USERINFO = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/]*)@/;

export const CLONE_REFUSALS = {
  empty: "No repository was given.",
  tooLong: "That address is too long.",
  characters:
    "A repository address cannot contain spaces, control characters or letters outside plain ASCII.",
  dash: "A repository address cannot begin with -.",
  credential:
    "That address has a user name, token or password in it. Pass it without one: this computer's git signs in on its own.",
  http: "Plain http:// addresses are not accepted; use https://.",
  form: "Only a GitHub owner/name, an https:// address, or an ssh address (git@host:owner/name or ssh://…) can be cloned. Local folders, file: and other transports are refused.",
  name: "That address does not name a repository.",
} as const;

const refuse = (reason: string): ParsedCloneAddress => ({ ok: false, reason });

/** A path's segments, none of them `.` or `..`; null when one is. */
function segmentsOf(repoPath: string): string[] | null {
  const segments = repoPath.split("/");
  return segments.every((s) => !/^\.+$/.test(s)) ? segments : null;
}

/** The folder name a repository's last segment gives: safe characters, never hidden, `.` or `..`. */
function folderName(last: string): string | null {
  const name = last
    .replace(/\.git$/i, "")
    .replace(/[^A-Za-z0-9_.-]/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/\.+$/, "")
    .slice(0, MAX_NAME);
  return name && !/^\.+$/.test(name) ? name : null;
}

/** The repository an address names, or why it is refused (in words that never repeat it). */
export function parseCloneAddress(input: string): ParsedCloneAddress {
  if (!input) return refuse(CLONE_REFUSALS.empty);
  if (input.length > MAX_LENGTH) return refuse(CLONE_REFUSALS.tooLong);
  if (/[^\x21-\x7E]/.test(input)) return refuse(CLONE_REFUSALS.characters);
  if (input.startsWith("-")) return refuse(CLONE_REFUSALS.dash);

  const userinfo = USERINFO.exec(input);
  if (userinfo) {
    const scheme = userinfo[1]!.toLowerCase();
    // https carries no user of its own: anything there is a credential. ssh has
    // a user (`git@`), never a password.
    if (scheme === "https" || scheme === "http" || userinfo[2]!.includes(":")) {
      return refuse(CLONE_REFUSALS.credential);
    }
  }

  let url: string;
  let repoPath: string;
  const github = OWNER_NAME.exec(input);
  if (github) {
    const [, owner, name] = github;
    url = `https://github.com/${owner}/${name!.replace(/\.git$/i, "")}`;
    repoPath = `${owner}/${name}`;
  } else {
    const match = HTTPS.exec(input) ?? SCP.exec(input) ?? SSH.exec(input);
    if (!match) {
      return refuse(/^http:\/\//i.test(input) ? CLONE_REFUSALS.http : CLONE_REFUSALS.form);
    }
    url = input.replace(/\/$/, "");
    repoPath = match[1]!;
  }

  const segments = segmentsOf(repoPath);
  const name = segments && folderName(segments.at(-1)!);
  if (!name) return refuse(CLONE_REFUSALS.name);
  return { ok: true, address: { url, name, key: repositoryKey(url) } };
}

/** One repository's identity, whatever form its address was written in. */
export function repositoryKey(origin: string): string {
  return normalizeRepoRef(httpsOrigin(origin));
}

/** Where the app's "Clone from GitHub" puts a repository by default: `~/Developer/<name>`. */
export function projectsFolder(): string {
  return path.join(os.homedir(), "Developer");
}
