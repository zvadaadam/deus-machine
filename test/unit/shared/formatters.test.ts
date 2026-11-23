import { expect, it } from "vitest";
import { abbreviatePath } from "@/shared/lib/formatters";

it.each([
  ["/Users/ali/Developer/project", "~/Developer/project"],
  ["/home/ali/src/project", "~/src/project"],
  ["/opt/projects/ali", "/opt/projects/ali"],
  ["/Users/alicia/project", "~/project"],
  ["/Users/ali", "~"],
])("abbreviates %s as %s", (path, display) => {
  expect(abbreviatePath(path)).toBe(display);
});
