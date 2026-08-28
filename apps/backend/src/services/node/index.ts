/**
 * Node addressing — the communication vocabulary of the node mesh.
 *
 * See `docs/node-mesh-plan.md`. Every live resource (a workspace, session, file
 * tree, terminal…) is addressed by a node-qualified `(node, kind, id)` ref, and
 * everything the mesh does is verbs on that ref. This module is the single
 * contract cloud, local, and future nodes all speak: `workspaceNodeId` /
 * `resolveNode` (driver.ts) route by the owning node today; `ResourceRef` +
 * `formatRef` / `parseRef` are the serialization the frontend federation and the
 * NRP wire will carry. Some of it is consumed here now, some by those layers —
 * it is intentional API surface, not dead code.
 *
 * `NodeId` is a plain string today (`"local"` / `"cloud"`) but is kept opaque and
 * *derived* rather than parsed, so it can later become a public-key hash
 * (self-certifying node identity — Tailscale/Syncthing/AT Proto) without touching
 * call sites. Populating the `node` dimension now, while it is always
 * local/cloud, is the cheap-early move that keeps future nodes an extension
 * rather than a rewrite.
 */

/** Stable identifier of a node that owns resources. Opaque; derived, not parsed. */
export type NodeId = string;

/** This machine's own backend. */
export const LOCAL_NODE_ID: NodeId = "local";

/** The user's cloud (agnt `AgentSession` DO + E2B sidecar). One cloud node for now. */
export const CLOUD_NODE_ID: NodeId = "cloud";

/**
 * The kinds of resource a node can host. Keep this as thin as the real nodes
 * need — do not gold-plate it for node types that don't exist yet.
 */
export const RESOURCE_KINDS = ["workspace", "session", "fs", "pty", "diff", "repo"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/** A node-qualified address for any resource. The noun of the mesh. */
export interface ResourceRef {
  node: NodeId;
  kind: ResourceKind;
  id: string;
}

/**
 * Which node owns this workspace's resources. The single "where does this
 * workspace live" predicate: cloud workspaces live on the cloud node,
 * everything else is local. Phase 1's `NodeDriver` (`resolveNode`) routes its
 * transport against this.
 */
export function workspaceNodeId(ws: { kind?: string | null }): NodeId {
  return ws.kind === "cloud" ? CLOUD_NODE_ID : LOCAL_NODE_ID;
}

/** Build a ref. */
export function resourceRef(node: NodeId, kind: ResourceKind, id: string): ResourceRef {
  return { node, kind, id };
}

/** The workspace itself, as a ref — the obvious first address. */
export function workspaceRef(ws: { id: string; kind?: string | null }): ResourceRef {
  return { node: workspaceNodeId(ws), kind: "workspace", id: ws.id };
}

function isResourceKind(v: string): v is ResourceKind {
  return (RESOURCE_KINDS as readonly string[]).includes(v);
}

/**
 * Canonical string form for logs and cache keys: `node/kind/id`.
 * `node` and `kind` never contain "/", so an `id` that does (an fs path) still
 * round-trips through {@link parseRef}.
 */
export function formatRef(ref: ResourceRef): string {
  return `${ref.node}/${ref.kind}/${ref.id}`;
}

/** Parse the canonical form. Throws on malformed input or an unknown kind. */
export function parseRef(s: string): ResourceRef {
  const first = s.indexOf("/");
  const second = first < 0 ? -1 : s.indexOf("/", first + 1);
  if (first < 0 || second < 0) {
    throw new Error(`Invalid ResourceRef: ${JSON.stringify(s)}`);
  }
  const node = s.slice(0, first);
  const kind = s.slice(first + 1, second);
  const id = s.slice(second + 1);
  if (!node || !id || !isResourceKind(kind)) {
    throw new Error(`Invalid ResourceRef: ${JSON.stringify(s)}`);
  }
  return { node, kind, id };
}
