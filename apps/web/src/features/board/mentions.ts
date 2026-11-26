import type { Parent, Root, RootContent, Text } from "mdast";

/** Replace only standalone mentions in prose. Code and links keep their literal contents. */
export function boardMentions(person: string) {
  const mention = /((?<![\p{L}\p{N}_@./-])@you(?![\p{L}\p{N}_-]))/giu;
  function visit(parent: Parent) {
    parent.children = parent.children.flatMap<RootContent>((node) => {
      if (node.type === "link" || node.type === "linkReference") return [node];
      if ("children" in node) visit(node);
      if (node.type !== "text") return [node];
      const parts = node.value.split(mention);
      if (parts.length === 1) return [node];
      return parts.filter(Boolean).map(
        (part): Text =>
          part.toLowerCase() === "@you"
            ? {
                type: "text",
                value: "@" + person,
                data: {
                  hName: "span",
                  hProperties: { className: "rounded-full bg-primary/8 px-1.5 text-primary" },
                },
              }
            : { type: "text", value: part }
      );
    });
  }
  return () => (tree: Root) => visit(tree);
}
