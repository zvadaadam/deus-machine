export type QueryParams = Record<string, unknown>;

export function readStringParam(params: QueryParams, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" ? value : undefined;
}

export function readNumberParam(params: QueryParams, key: string): number | undefined {
  const value = params[key];
  return typeof value === "number" ? value : undefined;
}

export function requireParam(params: QueryParams, key: string, context = "resource"): string {
  const value = readStringParam(params, key);
  if (!value) throw new Error(`${context} requires ${key}`);
  return value;
}
