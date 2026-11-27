import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { expect, it } from "vitest";
import { mentionsPerson } from "@shared/board-mentions";
import { boardMentions } from "../../../apps/web/src/features/board/mentions";

it.each([
  ["Can @you check?", true],
  ["First line\n@you", true],
  ["Hi, (@you)!", true],
  ["**@You**", true],
  ["@your call", false],
  ["a@you.org", false],
  ["Keep `@you` literal", false],
  ["~~~md\n@you\n~~~", false],
  ["[@you](report.md)", false],
  ["[report](@you)", false],
  ["![@you](image.png)", false],
  ["[@you][report]\n\n[report]: report.md", false],
  ["https://example.org/?q=@you", false],
] as const)("agrees on whether %j mentions the person", (body, expected) => {
  const html = renderToStaticMarkup(
    createElement(Markdown, { remarkPlugins: [remarkGfm, boardMentions("Ada")] }, body)
  );
  expect(html.includes("@Ada")).toBe(expected);
  expect(mentionsPerson(body)).toBe(expected);
});
