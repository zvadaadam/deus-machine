import { describe, expect, it } from "vitest";
import { automationsInOrganization, inOrganization } from "@/features/automations/lib/organization";
import type { Automation } from "@/shared/types";

const automation = (id: string, organization_id: string | null) =>
  ({ id, organization_id }) as Automation;
const ALL = [
  automation("a1", "org_a"),
  automation("b1", "org_b"),
  automation("legacy", null),
  automation("gone", "org_gone"),
];
const organizations = {
  available: true,
  defaultOrganizationId: "org_a",
  items: [
    { id: "org_a", name: "Acme", role: "owner", ready: true },
    { id: "org_b", name: "Beta", role: "member", ready: true },
  ],
};
const ids = (list: Automation[]) => list.map((a) => a.id);

describe("the automations page's organization", () => {
  it("shows only the window's organization's automations", () => {
    expect(ids(automationsInOrganization(ALL, organizations, "org_b"))).toEqual(["b1"]);
  });
  it("counts a row with no organization, or one the list lacks, as the default one's", () => {
    expect(ids(automationsInOrganization(ALL, organizations, "org_a"))).toEqual([
      "a1",
      "legacy",
      "gone",
    ]);
  });
  it("shows everything with no list (one nameless cloud)", () => {
    const none = { available: true, defaultOrganizationId: null, items: [] };
    expect(ids(automationsInOrganization(ALL, none, null))).toEqual(ids(ALL));
    expect(ids(automationsInOrganization(ALL, undefined, null))).toEqual(ids(ALL));
  });
});

describe("a new automation's organization", () => {
  it("is the window's, named in what the page sends", () => {
    expect(inOrganization({ name: "Nightly" }, "org_b")).toEqual({
      name: "Nightly",
      organization_id: "org_b",
    });
  });
  it("is left to the backend's default with no organization", () => {
    expect(inOrganization({ name: "Nightly" }, null)).toEqual({ name: "Nightly" });
  });
});
