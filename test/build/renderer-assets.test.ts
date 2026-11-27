import { expect, test } from "bun:test";

const index = await Bun.file(new URL("../../out/renderer/index.html", import.meta.url)).text();

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
  for (const url of urls) expect(url).toMatch(/^\/assets\//);
});
