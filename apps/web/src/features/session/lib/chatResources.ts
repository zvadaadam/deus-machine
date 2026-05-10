import type { Part, ToolPart } from "@shared/messages/types";
import { normalizeWorkspaceRelativePath } from "@/features/workspace/lib/normalizeWorkspaceRelativePath";

export type ChatResourceType = "website" | "file";

export type ResourceAction =
  | { kind: "deus-browser"; label: string; url: string }
  | { kind: "deus-browser-file"; label: string; path: string }
  | { kind: "deus-file"; label: string; path: string; target: "files" | "changes" }
  | { kind: "system-browser"; label: string; url: string }
  | { kind: "system-file"; label: string; path: string }
  | { kind: "finder"; label: string; path: string };

export interface ChatResource {
  id: string;
  type: ChatResourceType;
  title: string;
  subtitle: string;
  path?: string;
  url?: string;
  primaryAction: ResourceAction;
  secondaryActions: ResourceAction[];
}

interface ExtractChatResourcesOptions {
  parts: Part[];
  isComplete: boolean;
  workspacePath?: string | null;
}

const FILE_CARD_EXTENSIONS = new Set([
  "csv",
  "doc",
  "docx",
  "md",
  "mdx",
  "pdf",
  "ppt",
  "pptx",
  "tsv",
  "xls",
  "xlsm",
  "xlsx",
]);

const BROWSER_PREVIEW_EXTENSIONS = new Set([
  "avif",
  "gif",
  "htm",
  "html",
  "jpeg",
  "jpg",
  "pdf",
  "png",
  "webp",
]);

const SOURCE_FILE_EXTENSIONS = new Set(["csv", "md", "mdx", "tsv"]);

const IMAGE_EXTENSIONS = new Set(["avif", "gif", "jpeg", "jpg", "png", "webp"]);
const DOCUMENT_EXTENSIONS = new Set(["doc", "docx", "md", "mdx", "pdf"]);
const SPREADSHEET_EXTENSIONS = new Set(["csv", "tsv", "xls", "xlsm", "xlsx"]);
const SLIDE_EXTENSIONS = new Set(["ppt", "pptx"]);

const URL_RE = /\bhttps?:\/\/[^\s<>)"'`]+/gi;
const TRAILING_URL_PUNCTUATION_RE = /[.,;!?]+$/u;
const URL_BRACKET_RE = /[()[\]]/u;
const LOCAL_URL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function extractChatResources({
  parts,
  isComplete,
  workspacePath,
}: ExtractChatResourcesOptions): ChatResource[] {
  if (!isComplete) return [];

  const sortedParts = [...parts].sort((a, b) => (a.partIndex ?? 0) - (b.partIndex ?? 0));
  const assistantContent = sortedParts
    .filter((part) => part.type === "TEXT")
    .map((part) => part.text)
    .join("\n");

  const editedPaths = extractEditedPaths(sortedParts, workspacePath);
  const markdownPaths = extractMarkdownLinkDestinations(assistantContent)
    .map((path) => normalizeResourcePath(path, workspacePath))
    .filter((path): path is string => path != null);

  const filePaths = dedupePaths([
    ...editedPaths,
    ...extractReferencedPaths(sortedParts, workspacePath),
    ...markdownPaths,
  ]).filter((path) => {
    const extension = getExtension(path);
    return extension != null && FILE_CARD_EXTENSIONS.has(extension);
  });

  const resources = filePaths.map((path) =>
    isHtmlPath(path) ? createHtmlWebsiteResource(path) : createFileResource(path)
  );
  const localUrl = extractSingleLocalUrl(assistantContent);
  if (localUrl) {
    resources.push(createWebsiteResource(localUrl));
    return resources;
  }

  const htmlPaths = dedupePaths(editedPaths).filter((path) => {
    const extension = getExtension(path);
    return extension === "html" || extension === "htm";
  });
  if (htmlPaths.length === 1) {
    const htmlResourceId = `website-file:${htmlPaths[0]}`;
    return resources.some((resource) => resource.id === htmlResourceId)
      ? resources
      : [...resources, createHtmlWebsiteResource(htmlPaths[0])];
  }

  return resources;
}

function isHtmlPath(path: string): boolean {
  const extension = getExtension(path);
  return extension === "html" || extension === "htm";
}

export function extractSingleLocalUrl(text: string | null | undefined): string | null {
  if (!text) return null;

  const urls = new Set<string>();
  for (const match of text.matchAll(URL_RE)) {
    const url = normalizeLocalUrl(match[0]);
    if (url) urls.add(url);
  }

  return urls.size === 1 ? (urls.values().next().value ?? null) : null;
}

export function extractMarkdownLinkDestinations(markdown: string | null | undefined): string[] {
  if (!markdown?.includes("](")) return [];

  const destinations: string[] = [];
  let inFence = false;
  let fenceMarker: "`" | "~" | null = null;

  for (const line of markdown.split(/\r?\n/u)) {
    const fence = line.match(/^\s{0,3}(```+|~~~+)/);
    if (fence) {
      const marker = fence[1][0] as "`" | "~";
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (fenceMarker === marker) {
        inFence = false;
        fenceMarker = null;
      }
      continue;
    }

    if (inFence) continue;
    extractDestinationsFromLine(line, destinations);
  }

  return destinations;
}

function extractDestinationsFromLine(line: string, destinations: string[]): void {
  let index = 0;
  while (index < line.length) {
    if (line[index] === "`") {
      const next = line.indexOf("`", index + 1);
      if (next === -1) break;
      index = next + 1;
      continue;
    }

    if (line[index] === "]" && line[index + 1] === "(") {
      const parsed = parseMarkdownDestination(line, index + 2);
      if (parsed) {
        destinations.push(parsed.destination);
        index = parsed.nextIndex;
        continue;
      }
    }

    index += 1;
  }
}

function parseMarkdownDestination(
  line: string,
  startIndex: number
): { destination: string; nextIndex: number } | null {
  let index = skipWhitespace(line, startIndex);
  if (line[index] === "<") {
    const close = line.indexOf(">", index + 1);
    if (close === -1) return null;
    const next = skipWhitespace(line, close + 1);
    if (line[next] !== ")") return null;
    return { destination: line.slice(index + 1, close).trim(), nextIndex: next + 1 };
  }

  const chars: string[] = [];
  let parenDepth = 0;
  while (index < line.length) {
    const char = line[index];
    if (char === "\n" || char === "\r") return null;
    if (char === "\\") {
      chars.push(line[index + 1] ?? char);
      index += line[index + 1] == null ? 1 : 2;
      continue;
    }
    if (char === "(") {
      parenDepth += 1;
      chars.push(char);
      index += 1;
      continue;
    }
    if (char === ")") {
      if (parenDepth === 0) {
        return { destination: chars.join("").trim(), nextIndex: index + 1 };
      }
      parenDepth -= 1;
      chars.push(char);
      index += 1;
      continue;
    }
    if ((char === " " || char === "\t") && parenDepth === 0) {
      const destination = chars.join("").trim();
      const next = skipMarkdownTitle(line, index);
      return next == null ? null : { destination, nextIndex: next };
    }
    chars.push(char);
    index += 1;
  }

  return null;
}

function skipMarkdownTitle(line: string, startIndex: number): number | null {
  let index = skipWhitespace(line, startIndex);
  const quote = line[index];
  if (quote !== `"` && quote !== `'` && quote !== "(") return null;

  const close = quote === "(" ? ")" : quote;
  index += 1;
  while (index < line.length) {
    if (line[index] === "\\") {
      index += 2;
      continue;
    }
    if (line[index] === close) {
      const next = skipWhitespace(line, index + 1);
      return line[next] === ")" ? next + 1 : null;
    }
    index += 1;
  }
  return null;
}

function skipWhitespace(line: string, index: number): number {
  while (line[index] === " " || line[index] === "\t") index += 1;
  return index;
}

function extractEditedPaths(parts: Part[], workspacePath?: string | null): string[] {
  const paths: string[] = [];

  for (const part of parts) {
    if (part.type !== "TOOL" || part.kind !== "write") continue;
    collectToolPaths(part, paths, workspacePath);
  }

  return dedupePaths(paths);
}

function extractReferencedPaths(parts: Part[], workspacePath?: string | null): string[] {
  const paths: string[] = [];

  for (const part of parts) {
    if (part.type !== "TOOL") continue;
    collectToolPaths(part, paths, workspacePath);
  }

  return dedupePaths(paths);
}

function collectToolPaths(
  part: ToolPart,
  paths: string[],
  workspacePath: string | null | undefined
): void {
  for (const location of part.locations ?? []) {
    const path = normalizeResourcePath(location.path, workspacePath);
    if (path) paths.push(path);
  }

  if (part.state.status !== "COMPLETED") return;
  for (const content of part.state.content ?? []) {
    if (content.type !== "diff") continue;
    const path = normalizeResourcePath(content.path, workspacePath);
    if (path) paths.push(path);
  }
}

export function normalizeResourcePath(
  rawPath: string | null | undefined,
  workspacePath?: string | null
): string | null {
  if (!rawPath) return null;

  let candidate = rawPath.trim().replace(/^`+|`+$/g, "");
  if (!candidate) return null;

  if (/^(?:[a-z][a-z0-9+.-]*:\/\/|www\.|mailto:|tel:)/i.test(candidate)) {
    return null;
  }

  candidate = stripLineSuffix(candidate).replace(/\\/g, "/");

  const normalizedWorkspace = workspacePath?.replace(/\\/g, "/").replace(/\/+$/u, "") ?? null;
  const isAbsolute = /^(?:[A-Za-z]:\/|\/)/.test(candidate);

  if (normalizedWorkspace && candidate.startsWith(`${normalizedWorkspace}/`)) {
    candidate = candidate.slice(normalizedWorkspace.length + 1);
  } else if (isAbsolute) {
    return null;
  }

  return normalizeWorkspaceRelativePath(candidate);
}

function stripLineSuffix(path: string): string {
  return path
    .replace(/#L\d+(?:C\d+)?(?:-L\d+(?:C\d+)?)?$/iu, "")
    .replace(/:(?:\d+)(?::\d+)?(?:-\d+(?::\d+)?)?$/u, "");
}

function normalizeLocalUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.replace(TRAILING_URL_PUNCTUATION_RE, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!parsed.port) return null;
  if (URL_BRACKET_RE.test(`${parsed.pathname}${parsed.search}${parsed.hash}`)) return null;
  if (!LOCAL_URL_HOSTS.has(parsed.hostname.toLowerCase())) return null;

  return parsed.href;
}

function createWebsiteResource(url: string): ChatResource {
  const parsed = new URL(url);
  const title =
    parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"
      ? `${parsed.hostname}:${parsed.port}`
      : parsed.host;

  return {
    id: `website:${url}`,
    type: "website",
    title,
    subtitle: "Website",
    url,
    primaryAction: { kind: "deus-browser", label: "Open", url },
    secondaryActions: [{ kind: "system-browser", label: "Open in External Browser", url }],
  };
}

function createHtmlWebsiteResource(path: string): ChatResource {
  return {
    id: `website-file:${path}`,
    type: "website",
    title: basename(path),
    subtitle: "Website",
    path,
    primaryAction: { kind: "deus-browser-file", label: "Open", path },
    secondaryActions: [
      { kind: "deus-file", label: "Open source", path, target: "files" },
      { kind: "finder", label: "Reveal in Finder", path },
    ],
  };
}

function createFileResource(path: string): ChatResource {
  const extension = getExtension(path) ?? "";
  const primaryAction = getPrimaryFileAction(path, extension);
  const secondaryActions = getSecondaryFileActions(path, primaryAction.kind);

  return {
    id: `file:${path}`,
    type: "file",
    title: basename(path),
    subtitle: getFileSubtitle(path),
    path,
    primaryAction,
    secondaryActions,
  };
}

function getPrimaryFileAction(path: string, extension: string): ResourceAction {
  if (isBrowserPreviewPath(path)) {
    return { kind: "deus-browser-file", label: "Open", path };
  }

  if (SOURCE_FILE_EXTENSIONS.has(extension)) {
    return { kind: "deus-file", label: "Open", path, target: "files" };
  }

  return { kind: "system-file", label: "Open", path };
}

function getSecondaryFileActions(
  path: string,
  primaryKind: ResourceAction["kind"]
): ResourceAction[] {
  const actions: ResourceAction[] = [];

  if (primaryKind !== "deus-file") {
    const extension = getExtension(path);
    if (extension && SOURCE_FILE_EXTENSIONS.has(extension)) {
      actions.push({ kind: "deus-file", label: "Open in Files", path, target: "files" });
    }
  }

  if (primaryKind !== "system-file") {
    actions.push({ kind: "system-file", label: "Open with Default App", path });
  }

  actions.push({ kind: "finder", label: "Reveal in Finder", path });
  return actions;
}

function getFileSubtitle(path: string): string {
  const extension = getExtension(path);
  if (!extension) return dirname(path) || "File";

  const label = extension.toUpperCase();
  if (DOCUMENT_EXTENSIONS.has(extension)) return `Document · ${label}`;
  if (SPREADSHEET_EXTENSIONS.has(extension)) return `Spreadsheet · ${label}`;
  if (SLIDE_EXTENSIONS.has(extension)) return `Slides · ${label}`;
  if (IMAGE_EXTENSIONS.has(extension)) return `Image · ${label}`;
  return dirname(path) || `File · ${label}`;
}

function extractExtension(path: string): string | null {
  const name = basename(path);
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === name.length - 1) return null;
  return name.slice(dotIndex + 1).toLowerCase();
}

function getExtension(path: string): string | null {
  return extractExtension(path);
}

export function isBrowserPreviewPath(path: string): boolean {
  const extension = getExtension(path);
  return extension != null && BROWSER_PREVIEW_EXTENSIONS.has(extension);
}

export function createWorkspacePreviewUrl(
  baseUrl: string,
  workspaceId: string,
  relativePath: string
): string {
  return `${baseUrl}/workspaces/${encodeURIComponent(workspaceId)}/file-preview?path=${encodeURIComponent(relativePath)}`;
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function dirname(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments.length > 1 ? segments.slice(0, -1).join("/") : "";
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(path);
  }
  return result;
}
