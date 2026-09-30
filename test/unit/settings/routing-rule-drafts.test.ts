import { expect, it } from "vitest";
import {
  dropRoutingRuleDraft,
  readRoutingRuleDraft,
  routingRuleDraftKey,
  writeRoutingRuleDraft,
} from "@/features/settings/lib/routing-rule-drafts";

it("keeps a dialog's unsaved text per account and rule until it is dropped", () => {
  const adding = routingRuleDraftKey("ada", null);
  const editing = routingRuleDraftKey("ada", "env-web");
  writeRoutingRuleDraft(adding, { environmentId: "env-mobile", description: "iOS and Android" });

  expect(readRoutingRuleDraft(adding)).toEqual({
    environmentId: "env-mobile",
    description: "iOS and Android",
  });
  expect(readRoutingRuleDraft(editing)).toBeUndefined();
  expect(readRoutingRuleDraft(routingRuleDraftKey("grace", null))).toBeUndefined();

  dropRoutingRuleDraft(adding);
  expect(readRoutingRuleDraft(adding)).toBeUndefined();
});
