/**
 * The secret the desktop spawns this backend with (`AUTH_TOKEN`): only its
 * holder may hand the backend account credentials (routes/settings.ts). It is
 * read once and removed from the environment, so nothing this process starts
 * (agents and their shells, terminals, git, gh, setup scripts) inherits it.
 * server.ts imports this module first, before anything can spawn.
 */
const token = process.env.AUTH_TOKEN || null;
delete process.env.AUTH_TOKEN;

export function spawnToken(): string | null {
  return token;
}
