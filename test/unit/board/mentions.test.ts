import { expect, it } from "vitest";
import { fromMarkdown } from "mdast-util-from-markdown";
import { boardMentions } from "../../../apps/web/src/features/board/mentions";

it("names the person in prose without rewriting code, links or email addresses", () => {
  const tree = fromMarkdown(
    "Hi **@you** and @Coordinator. Keep `@you`, mail@you.org and [@you](report.md).\n\n```\n@you\n```"
  );
  boardMentions("Adam")()(tree);
  const text = JSON.stringify(tree);
  expect(text).toContain('"hName":"span"');
  expect(text.match(/@Adam/g)).toHaveLength(1);
  expect(text.match(/@you/g)).toHaveLength(4);
  expect(text).toContain("@Coordinator");
});
