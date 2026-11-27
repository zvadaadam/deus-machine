import { visitPersonMentions } from "@shared/board-mentions";
import type { Root } from "mdast";

export function boardMentions(person: string) {
  return () => (tree: Root) => {
    visitPersonMentions(tree, () => ({
      type: "text",
      value: "@" + person,
      data: {
        hName: "span",
        hProperties: { className: "rounded-full bg-primary/8 px-1.5 text-primary" },
      },
    }));
  };
}
