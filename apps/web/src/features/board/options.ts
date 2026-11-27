import type { ListItem } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";

/** Only the first run of consecutive, single-line choices is actionable. */
export function boardOptions(body: string) {
  const lines = body.split(/\r\n?|\n/);
  const items: ListItem[] = [];
  const definitions: string[] = [];
  for (const block of fromMarkdown(body).children) {
    if (block.type === "definition") {
      definitions.push(body.slice(block.position!.start.offset, block.position!.end.offset));
    } else if (block.type === "list" && block.ordered) {
      for (const item of block.children) {
        if (item.children.length) items.push(item);
      }
    }
  }

  const run: ListItem[] = [];
  for (const item of items) {
    const previous = run.at(-1);
    if (previous && item.position!.start.line !== previous.position!.end.line + 1) {
      if (run.length >= 2) break;
      run.length = 0;
    }
    run.push(item);
  }
  if (run.length < 2) return null;

  const options: { number: string; text: string }[] = [];
  for (const item of run) {
    const { start, end } = item.position!;
    if (start.line !== end.line) return null;
    const match = /^ {0,3}(\d+)[.)][ \t]+(\S.*)$/.exec(lines[start.line - 1]!);
    if (!match) return null;
    options.push({ number: match[1]!, text: match[2]!.trimEnd() });
  }
  const start = run[0]!.position!.start.line - 1;
  // Each piece is rendered on its own. Keep reference links defined elsewhere in the post.
  const references = definitions.length ? definitions.join("\n") + "\n\n" : "";
  return {
    references,
    before: lines.slice(0, start).join("\n"),
    options,
    after: lines.slice(start + options.length).join("\n"),
  };
}
