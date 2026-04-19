// shared/aap/template.ts
// Template substitution for AAP manifest fields.
//
// Supported variables (per docs/aap-v1-design.html §05):
//   {port}               — host-allocated port for this launch
//   {workspace}          — absolute path of the current workspace
//   {storage.workspace}  — absolute path to per-workspace storage dir
//   {storage.global}     — absolute path to per-user storage dir
//   {userData}           — absolute path of Deus user-data dir
//
// Used on launch args, env values, cwd, ui.url, ready.path. Any token that
// matches the template pattern but isn't in the provided vars throws — no
// silent passthrough; the spec requires "unknown vars throw at launch".

export interface TemplateVars {
  port?: number;
  workspace?: string;
  userData?: string;
  storage?: {
    workspace?: string;
    global?: string;
  };
}

const TEMPLATE_PATTERN = /\{([a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)*)\}/g;

/** Walk `path` against `vars` using only own-property access. Guards against
 *  prototype traversal — crafted tokens like `{constructor.name}` must not
 *  silently resolve to `"Object"` once v2 accepts workspace-local manifests. */
function lookup(path: string, vars: TemplateVars): string | undefined {
  const parts = path.split(".");
  let value: unknown = vars;
  for (const part of parts) {
    if (value === null || typeof value !== "object") return undefined;
    if (!Object.hasOwn(value as object, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  if (value === undefined || value === null) return undefined;
  return typeof value === "number" ? String(value) : typeof value === "string" ? value : undefined;
}

/** Substitute all `{var}` and `{ns.key}` tokens in `input` using `vars`.
 *  Throws if a token is present but has no value. Literal text that doesn't
 *  match the template pattern (e.g. JSON braces) passes through unchanged. */
export function substituteTemplate(input: string, vars: TemplateVars): string {
  return input.replace(TEMPLATE_PATTERN, (_match, path: string) => {
    const value = lookup(path, vars);
    if (value === undefined) {
      throw new Error(`aap template: unknown variable "{${path}}"`);
    }
    return value;
  });
}

/** Apply `substituteTemplate` to every string entry in an args array. */
export function substituteArgs(args: string[], vars: TemplateVars): string[] {
  return args.map((arg) => substituteTemplate(arg, vars));
}

/** Apply `substituteTemplate` to every value of an env record. */
export function substituteEnv(
  env: Record<string, string>,
  vars: TemplateVars
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = substituteTemplate(value, vars);
  }
  return out;
}
