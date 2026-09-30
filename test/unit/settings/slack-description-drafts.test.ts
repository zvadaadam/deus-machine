import { expect, it } from "vitest";
import {
  clearDescriptionDraft,
  readDescriptionDraft,
  writeDescriptionDraft,
} from "@/features/settings/lib/slack-description-drafts";

it("keeps a draft per account and environment until it is saved", () => {
  writeDescriptionDraft("ada", "env", "billing", "api");
  expect(readDescriptionDraft("ada", "env")).toBe("billing");
  expect(readDescriptionDraft("grace", "env")).toBeUndefined();

  clearDescriptionDraft("ada", "env");
  expect(readDescriptionDraft("ada", "env")).toBeUndefined();
});

it("drops a draft that would save nothing, whitespace included", () => {
  writeDescriptionDraft("ada", "env", "billing", "api");
  writeDescriptionDraft("ada", "env", "  api ", "api");
  expect(readDescriptionDraft("ada", "env")).toBeUndefined();
});

it("keeps clearing a saved description as a draft", () => {
  writeDescriptionDraft("ada", "env", "", "api");
  expect(readDescriptionDraft("ada", "env")).toBe("");
});
