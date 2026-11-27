import type { Root, Text } from "mdast";
import { findAndReplace } from "mdast-util-find-and-replace";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

/** Only prose mentions the person. Markdown keeps code, image text and link destinations literal. */
export function visitPersonMentions(tree: Root, replace?: () => Text): boolean {
  let found = false;
  findAndReplace(
    tree,
    [
      /(?<![\p{L}\p{N}_@./-])@you(?![\p{L}\p{N}_-])/giu,
      () => {
        found = true;
        return replace?.() ?? false;
      },
    ],
    { ignore: ["link", "linkReference"] }
  );
  return found;
}

const boardMarkdown = { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] };

export function mentionsPerson(body: string): boolean {
  return visitPersonMentions(fromMarkdown(body, boardMarkdown));
}
