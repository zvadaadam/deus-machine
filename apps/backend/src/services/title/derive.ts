const MAX_TITLE_LENGTH = 60;
const BAD_TITLES = new Set(["(session)"]);

type ContentBlock = {
  type?: unknown;
  text?: unknown;
};

export function deriveSessionTitle(content: string): string | null {
  if (BAD_TITLES.has(content.trim().toLowerCase())) return null;
  const text = extractTextContent(content);
  const cleaned = cleanTitleText(text);
  if (!cleaned || BAD_TITLES.has(cleaned.toLowerCase())) return null;
  return truncateTitle(cleaned, MAX_TITLE_LENGTH);
}

export function isUsableSessionTitle(title: string | null | undefined): title is string {
  const normalized = title?.trim();
  return Boolean(normalized && !BAD_TITLES.has(normalized.toLowerCase()));
}

function extractTextContent(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return "";

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .map((block: unknown) => extractTextBlock(block))
        .filter(Boolean)
        .join("\n\n");
    }
    return extractTextBlock(parsed) || trimmed;
  } catch {
    return trimmed;
  }
}

function extractTextBlock(block: unknown): string {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return "";
  const typedBlock = block as ContentBlock;
  if (typedBlock.type === "text" && typeof typedBlock.text === "string") {
    return typedBlock.text;
  }
  return "";
}

function cleanTitleText(text: string): string {
  return text
    .replace(/<inspect\b[^>]*>([\s\S]*?)<\/inspect>/gi, " $1 ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(^|\s)\/[a-z0-9_-]+(?=\s|$)/gi, " ")
    .replace(/(^|\s)@\S+/g, " ")
    .replace(/[#*_~>\[\](){}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateTitle(title: string, maxLength: number): string {
  if (title.length <= maxLength) return title;
  const sliced = title.slice(0, maxLength + 1);
  const lastSpace = sliced.lastIndexOf(" ");
  const truncated = lastSpace >= 30 ? sliced.slice(0, lastSpace) : title.slice(0, maxLength);
  return `${truncated.trim()}…`;
}
