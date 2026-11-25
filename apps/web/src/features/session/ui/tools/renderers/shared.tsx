type TextResultBlock = {
  type: "text";
  text: string;
};

function isTextResultBlock(block: unknown): block is TextResultBlock {
  if (!block || typeof block !== "object") return false;
  const record = block as Record<string, unknown>;
  return record.type === "text" && typeof record.text === "string";
}

type ImageResultBlock = {
  type: "image";
  data?: string;
  mimeType?: string;
  source?: {
    data?: string;
    media_type?: string;
  };
};

function isImageResultBlock(block: unknown): block is ImageResultBlock {
  if (!block || typeof block !== "object") return false;
  return (block as Record<string, unknown>).type === "image";
}

type ToolImage = { data: string; mediaType: string };

export function extractImage(content: unknown): ToolImage | null {
  if (!Array.isArray(content)) return null;

  // Iterate through all image blocks — don't stop at the first one if its
  // payload is incomplete, since later valid images would be skipped.
  for (const block of content) {
    if (!isImageResultBlock(block)) continue;

    if (typeof block.data === "string") {
      return { data: block.data, mediaType: block.mimeType || "image/jpeg" };
    }
    if (typeof block.source?.data === "string") {
      return { data: block.source.data, mediaType: block.source.media_type || "image/jpeg" };
    }
  }

  return null;
}

export function renderToolImage(image: ToolImage, alt: string) {
  return (
    <img
      src={`data:${image.mediaType};base64,${image.data}`}
      alt={alt}
      className="border-border/40 max-w-full rounded-lg border shadow-sm"
    />
  );
}

export function extractText(content: unknown = ""): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(isTextResultBlock)
      .map((block) => block.text)
      .join("\n");
  }
  return JSON.stringify(content, null, 2);
}

export const ICON_CLS = "text-muted-foreground/70 h-3.5 w-3.5";
