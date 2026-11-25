/**
 * Omnibox helpers — URL detection and ranked workspace file search for New Tab.
 */

import type { FileTreeNode } from "@/features/file-browser/types";

/** File extensions that should be treated as source/data files rather than domain TLDs. */
const FILE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "json",
  "md",
  "mdx",
  "css",
  "scss",
  "less",
  "html",
  "htm",
  "xml",
  "svg",
  "yml",
  "yaml",
  "toml",
  "ini",
  "env",
  "txt",
  "log",
  "lock",
  "sh",
  "bash",
  "zsh",
  "py",
  "rb",
  "rs",
  "go",
  "java",
  "kt",
  "swift",
  "c",
  "h",
  "cpp",
  "hpp",
  "cs",
  "php",
  "sql",
  "prisma",
  "graphql",
  "gql",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "ico",
  "pdf",
  "wasm",
  "map",
  "vue",
  "svelte",
  "astro",
]);

const LOOPBACK_PATTERN = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d{1,5})?(\/.*)?$/i;

/**
 * Parse a user-typed omnibox query as a navigable URL when it unambiguously
 * represents one (explicit scheme, localhost/loopback including IPv6 `[::1]`,
 * port shorthand like `:3000`, or a domain name whose TLD is not a source file extension).
 */
export function parseOmniboxUrl(rawInput: string): string | null {
  const input = rawInput.trim();
  if (!input || /\s/.test(input)) return null;

  // Explicit http(s) scheme
  if (/^https?:\/\//i.test(input)) {
    try {
      const parsed = new URL(input);
      return parsed.hostname ? parsed.toString() : null;
    } catch {
      return null;
    }
  }

  // Port shorthand like ":3000" or ":5173/dashboard"
  if (/^:\d{2,5}(\/.*)?$/.test(input)) {
    return `http://localhost${input}`;
  }

  // Localhost or IPv4/IPv6 loopback (with optional port/path)
  if (LOOPBACK_PATTERN.test(input)) {
    return `http://${input}`;
  }

  // Domain pattern: host.tld(:port)?(/path)?
  const domainMatch = /^([a-z0-9-]+(?:\.[a-z0-9-]+)+)(:\d{1,5})?(\/.*)?$/i.exec(input);
  if (!domainMatch) return null;

  const host = domainMatch[1];
  const hasPort = Boolean(domainMatch[2]);
  const hasPath = Boolean(domainMatch[3]);
  const tld = host.slice(host.lastIndexOf(".") + 1).toLowerCase();

  // If no explicit port/path and the suffix looks like a code file (e.g. App.tsx), treat as file search.
  if (!hasPort && !hasPath && FILE_EXTENSIONS.has(tld)) {
    return null;
  }

  // Require at least 2 alphabetic chars for a TLD (avoid matching version strings like 1.2)
  if (!/^[a-z]{2,24}$/.test(tld)) return null;

  return `https://${input}`;
}

/**
 * Normalize explicit URL bar input (where the user definitely wants to navigate,
 * unlike the omnibox which distinguishes filenames from domains).
 */
export function normalizeNavigationUrl(rawInput: string): string {
  const trimmed = rawInput.trim();
  if (/^:\d{2,5}(\/.*)?$/.test(trimmed)) return `http://localhost${trimmed}`;
  if (LOOPBACK_PATTERN.test(trimmed)) {
    return `http://${trimmed}`;
  }
  if (
    !trimmed.startsWith("http://") &&
    !trimmed.startsWith("https://") &&
    !trimmed.startsWith("file://")
  ) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

export interface FlatWorkspaceFile {
  name: string;
  path: string;
  directory: string;
}

/** Flatten a recursive FileTreeNode[] into a flat list of files for fast search. */
export function flattenFileTree(nodes: FileTreeNode[]): FlatWorkspaceFile[] {
  const result: FlatWorkspaceFile[] = [];

  function walk(list: FileTreeNode[]) {
    for (const node of list) {
      if (node.type === "file") {
        const idx = node.path.lastIndexOf("/");
        result.push({
          name: node.name,
          path: node.path,
          directory: idx >= 0 ? node.path.slice(0, idx) : "",
        });
      } else if (node.children) {
        walk(node.children);
      }
    }
  }

  walk(nodes);
  return result;
}

/** Rank and filter flattened workspace files by query. */
export function searchWorkspaceFiles(
  files: FlatWorkspaceFile[],
  rawQuery: string,
  limit = 8
): FlatWorkspaceFile[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return [];

  const scored: Array<{ file: FlatWorkspaceFile; score: number }> = [];

  for (const file of files) {
    const nameLower = file.name.toLowerCase();
    const pathLower = file.path.toLowerCase();

    let score = 0;
    if (nameLower === query) {
      score = 1000;
    } else if (nameLower.startsWith(query)) {
      score = 800 - nameLower.length;
    } else if (nameLower.includes(query)) {
      score = 600 - nameLower.indexOf(query) - nameLower.length * 0.1;
    } else if (pathLower.includes(query)) {
      score = 300 - pathLower.indexOf(query) * 0.5 - pathLower.length * 0.1;
    }

    if (score > 0) {
      scored.push({ file, score });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path));
  return scored.slice(0, limit).map((s) => s.file);
}
