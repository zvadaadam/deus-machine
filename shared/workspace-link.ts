export interface WorkspaceLink {
  workspaceId: string;
  sessionId?: string;
}

const scheme = "deus:";
const base = `${scheme}//workspace`;
const uuid = "[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}";
const id = new RegExp(`^${uuid}$`);
const address = new RegExp(`^${base}/?\\?id=(${uuid})(?:&session=(${uuid}))?$`);

/** Workspace and chat ids are case-sensitive keys with the UUID shape. */
export function isWorkspaceLinkId(value: unknown): value is string {
  return typeof value === "string" && id.test(value);
}

/** A launch argument can offer a Deus address even when the parser refuses it. */
export function hasWorkspaceLinkScheme(text: string): boolean {
  return text.trimStart().slice(0, scheme.length).toLowerCase() === scheme;
}

/** "deus://workspace?id=…" and, with a chat, "&session=…". */
export function workspaceLink({ workspaceId, sessionId }: WorkspaceLink): string {
  const params = new URLSearchParams({ id: workspaceId });
  if (sessionId !== undefined) params.set("session", sessionId);
  return `${base}?${params}`;
}

/** The link's ids, or null for anything but that exact shape. */
export function parseWorkspaceLink(text: string): WorkspaceLink | null {
  const match = address.exec(text);
  if (!match) return null;
  const [, workspaceId, sessionId] = match;
  return sessionId ? { workspaceId, sessionId } : { workspaceId };
}
