/**
 * Node addressing — the communication vocabulary of the node mesh.
 *
 * See `docs/node-mesh-plan.md`. `workspaceNodeId` / `resolveNode` (driver.ts)
 * route a workspace's live resources by the node that owns them.
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
 * Which node owns this workspace's resources. The single "where does this
 * workspace live" predicate: cloud workspaces live on the cloud node,
 * everything else is local. Phase 1's `NodeDriver` (`resolveNode`) routes its
 * transport against this.
 */
export function workspaceNodeId(ws: { kind?: string | null }): NodeId {
  return ws.kind === "cloud" ? CLOUD_NODE_ID : LOCAL_NODE_ID;
}
