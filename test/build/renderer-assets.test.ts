import { expect, test } from "bun:test";
import { posix } from "node:path";

const index = await Bun.file(new URL("../../out/renderer/index.html", import.meta.url)).text();

function loadsFromAssets(href: string) {
  if (!href.startsWith("/assets/")) return false;
  const { pathname } = new URL(href, "https://deus.invalid/b/board");
  return posix.normalize(decodeURIComponent(pathname)).startsWith("/assets/");
}

test.each(["./assets/entry.js", "/assets/../entry.js", "/assets/..%2fentry.js"])(
  "the packaged renderer rejects %s",
  (href) => expect(loadsFromAssets(href)).toBe(false)
);

test.each([
  ["script[src]", "src"],
  ['link[rel~="stylesheet" i]', "href"],
])("the built renderer loads %s from /assets/ on every route", (selector, attribute) => {
  const urls: string[] = [];
  new HTMLRewriter()
    .on(selector, {
      element(element) {
        urls.push(element.getAttribute(attribute) ?? "");
      },
    })
    .transform(index);
  expect(urls.length).toBeGreaterThan(0);
  for (const url of urls) expect(loadsFromAssets(url), url).toBe(true);
});
