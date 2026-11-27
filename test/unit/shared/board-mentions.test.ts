import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Database from "better-sqlite3";
import { mentionCandidateSql } from "../../../apps/backend/src/services/boards/questions";
import { afterAll, expect, it } from "vitest";
import { mentionsPerson } from "@shared/board-mentions";
import { boardMentions } from "../../../apps/web/src/features/board/mentions";

const db = new Database(":memory:");
const prefilter = db.prepare<[string], { candidate: number }>(
  `SELECT ${mentionCandidateSql} AS candidate FROM (SELECT ? AS body) q`
);
afterAll(() => db.close());

// Body, rendered mention, SQL candidate (the prefilter may admit ordinary prose).
it.each([
  ["Can @you check?", true, true],
  ["First line\n@you", true, true],
  ["Hi, (@you)!", true, true],
  ["**@You**", true, true],
  ["&#64;you", true, true],
  ["&#x40;you", true, true],
  ["&commat;you", true, true],
  ["\\@you", true, true],
  ["Blue &amp; green", false, true],
  ["All checks passed", false, false],
  ["@your call", false, true],
  ["a@you.org", false, true],
  ["Keep `@you` literal", false, true],
  ["~~~md\n@you\n~~~", false, true],
  ["[@you](report.md)", false, true],
  ["[report](@you)", false, true],
  ["![@you](image.png)", false, true],
  ["[@you][report]\n\n[report]: report.md", false, true],
  ["https://example.org/?q=@you", false, true],
] as const)("agrees on whether %j mentions the person", (body, expected, candidate) => {
  const html = renderToStaticMarkup(
    createElement(Markdown, { remarkPlugins: [remarkGfm, boardMentions("Ada")] }, body)
  );
  expect(Boolean(prefilter.get(body)?.candidate)).toBe(candidate);
  expect(html.includes("@Ada")).toBe(expected);
  expect(mentionsPerson(body)).toBe(expected);
});
