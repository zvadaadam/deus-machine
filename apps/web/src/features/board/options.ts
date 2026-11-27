import { fromMarkdown } from "mdast-util-from-markdown";

/** Only the first run of consecutive, single-line choices is actionable. */
export function boardOptions(body: string) {
  const lines = body.split(/\r\n?|\n/);
  const items = new Set<number>();
  const definitions: string[] = [];
  for (const block of fromMarkdown(body).children) {
    if (block.type === "definition") {
      definitions.push(body.slice(block.position!.start.offset, block.position!.end.offset));
    } else if (block.type === "list" && block.ordered) {
      for (const item of block.children) items.add(item.position!.start.line - 1);
    }
  }

  let start = 0;
  const options: { number: string; text: string }[] = [];
  for (const [index, line] of lines.entries()) {
    const match = items.has(index) && /^ {0,3}(\d+)[.)][ \t]+(\S.*)$/.exec(line);
    if (match) {
      if (!options.length) start = index;
      options.push({ number: match[1]!, text: match[2]!.trimEnd() });
    } else if (options.length >= 2) {
      break;
    } else {
      options.length = 0;
    }
  }
  if (options.length < 2) return null;
  // Each piece is rendered on its own. Keep reference links defined elsewhere in the post.
  const references = definitions.length ? definitions.join("\n") + "\n\n" : "";
  return {
    references,
    before: lines.slice(0, start).join("\n"),
    options,
    after: lines.slice(start + options.length).join("\n"),
  };
}
