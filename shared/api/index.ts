/**
 * Every operation a Deus host answers, by name.
 *
 * `api.diffStats` is the declaration both sides share: the web app calls it
 * (`call(api.diffStats, { workspaceId })`), the backend registers its handler
 * (`handle(api.diffStats, …)`). Adding an operation is one declaration in its
 * domain file here and one handler in `apps/backend/src/api`.
 */

import { isOp, type AnyOp } from "./op";
import * as workspaces from "./workspaces";

export const api = { ...workspaces };
export type Api = typeof api;

export const ops: readonly AnyOp[] = Object.values(api).filter(isOp);

type NamesWhere<Shape> = {
  [K in keyof Api]: Api[K] extends Shape ? Api[K]["name"] : never;
}[keyof Api];

/** Names of the reads a client can subscribe to and the backend can invalidate. */
export type LiveName = NamesWhere<{ live: true }>;

export type { AnyOp, InputOf, OutputOf, ParsedInputOf, Op } from "./op";
