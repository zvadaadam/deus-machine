/**
 * One declaration per operation a client can ask a Deus host for.
 *
 * An operation is a name, what it takes (a zod schema, checked where a frame
 * arrives) and what it answers (a type). The backend registers one handler per
 * operation (`apps/backend/src/api`); the web app calls it with `call(op, input)`
 * and both sides are typed by the declaration, so a renamed field or a missing
 * parameter is a compile error instead of a runtime surprise.
 *
 *   read   answers a question. Safe to repeat; sent as `q:request`.
 *   live   a read the host sends again to subscribers when it changes
 *          (`q:subscribe`); `invalidate(["name"])` on the backend triggers it.
 *   write  changes something. Sent once as `q:mutate`; a lost reply leaves the
 *          outcome unknown and is never retried by the transport.
 */

import { z } from "zod";

declare const OUTPUT: unique symbol;
/** Type-only marker: what an operation answers with. Nothing exists at runtime. */
export interface Out<T> {
  readonly [OUTPUT]?: T;
}
export const out = <T>(): Out<T> => ({});

export type OpKind = "read" | "write";

export interface Op<
  Name extends string = string,
  Input extends z.ZodType = z.ZodType,
  Output = unknown,
  Kind extends OpKind = OpKind,
  Live extends boolean = boolean,
> {
  readonly name: Name;
  readonly kind: Kind;
  readonly live: Live;
  readonly input: Input;
  readonly output: Out<Output>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the variance-free "some operation"
export type AnyOp = Op<string, z.ZodType, any, OpKind, boolean>;
/** What a caller passes (before defaults are applied). */
export type InputOf<O extends AnyOp> = z.input<O["input"]>;
/** What a handler receives (validated, defaults applied). */
export type ParsedInputOf<O extends AnyOp> = z.output<O["input"]>;
export type OutputOf<O extends AnyOp> =
  O extends Op<string, z.ZodType, infer T, OpKind, boolean> ? T : never;

const NO_INPUT = z.object({});
type NoInput = typeof NO_INPUT;

interface Declaration<Name extends string, Input extends z.ZodType, Output> {
  name: Name;
  /** Omit for an operation that takes nothing. */
  input?: Input;
  output: Out<Output>;
}

function declare<
  const Name extends string,
  Output,
  Input extends z.ZodType,
  Kind extends OpKind,
  Live extends boolean,
>(
  def: Declaration<Name, Input, Output>,
  kind: Kind,
  live: Live
): Op<Name, Input, Output, Kind, Live> {
  return {
    name: def.name,
    kind,
    live,
    input: (def.input ?? NO_INPUT) as Input,
    output: def.output,
  };
}

export function read<const Name extends string, Output, Input extends z.ZodType = NoInput>(
  def: Declaration<Name, Input, Output>
): Op<Name, Input, Output, "read", false> {
  return declare(def, "read", false);
}

export function live<const Name extends string, Output, Input extends z.ZodType = NoInput>(
  def: Declaration<Name, Input, Output>
): Op<Name, Input, Output, "read", true> {
  return declare(def, "read", true);
}

export function write<const Name extends string, Output, Input extends z.ZodType = NoInput>(
  def: Declaration<Name, Input, Output>
): Op<Name, Input, Output, "write", false> {
  return declare(def, "write", false);
}

export function isOp(value: unknown): value is AnyOp {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    "kind" in value &&
    "input" in value &&
    "output" in value
  );
}

/**
 * One line a person can act on. A missing parameter reads as
 * "diffStats requires workspaceId"; anything else names the field and the rule.
 */
export function describeInputError(op: AnyOp, error: z.ZodError, input: unknown): string {
  const issue = error.issues[0];
  if (!issue) return `${op.name}: invalid input`;
  const field = issue.path.join(".");
  if (!field) return `${op.name}: ${issue.message}`;
  let value: unknown = input;
  for (const key of issue.path) {
    value =
      typeof value === "object" && value !== null
        ? (value as Record<PropertyKey, unknown>)[key]
        : undefined;
  }
  if (issue.code === "invalid_type" && value === undefined) return `${op.name} requires ${field}`;
  return `${op.name}: ${field}: ${issue.message}`;
}
