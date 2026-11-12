/**
 * Every operation a Deus host answers, by name.
 *
 * `api.diffStats` is the declaration both sides share: the web app calls it
 * (`call(api.diffStats, { workspaceId })`), the backend registers its handler
 * (`handle(api.diffStats, …)`). Adding an operation is one declaration in its
 * domain file here and one handler in `apps/backend/src/api`.
 */

import { isOp, type AnyOp } from "./op";
import { isStream, type AnyStream } from "./stream";
import * as automations from "./automations";
import * as browser from "./browser";
import * as devices from "./devices";
import * as files from "./files";
import * as integrations from "./integrations";
import * as repos from "./repos";
import * as sessions from "./sessions";
import * as settings from "./settings";
import * as simulator from "./simulator";
import * as terminal from "./terminal";
import * as workspaces from "./workspaces";

export const api = {
  ...automations,
  ...browser,
  ...devices,
  ...files,
  ...integrations,
  ...repos,
  ...sessions,
  ...settings,
  ...simulator,
  ...terminal,
  ...workspaces,
};
export type Api = typeof api;

const declared: unknown[] = Object.values(api);

export const ops: readonly AnyOp[] = declared.filter(isOp);

/** Every stream of events a client can listen to. */
export const streams: readonly AnyStream[] = declared.filter(isStream);

type NamesWhere<Shape> = {
  [K in keyof Api]: Api[K] extends Shape ? Api[K]["name"] : never;
}[keyof Api];

/** Names of the reads a client can subscribe to and the backend can invalidate. */
export type LiveName = NamesWhere<{ live: true }>;

export type { AnyOp, InputOf, OutputOf, ParsedInputOf, Op } from "./op";
