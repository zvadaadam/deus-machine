import { describe, expect, it } from "vitest";
import { sectionOrganization } from "@/features/settings/lib/section-organization";

const items = [{ id: "org_a" }, { id: "org_b" }];

describe("a Settings section's organization", () => {
  it("is the window's organization when the section's list names it", () => {
    expect(sectionOrganization(null, "org_b", items)).toBe("org_b");
  });
  it("is the section's own choice once it made one", () => {
    expect(sectionOrganization("org_a", "org_b", items)).toBe("org_a");
  });
  it("falls back to the first listed when neither is listed", () => {
    expect(sectionOrganization("gone", "elsewhere", items)).toBe("org_a");
    expect(sectionOrganization(null, null, items)).toBe("org_a");
  });
  it("is none with no list", () => {
    expect(sectionOrganization(null, "org_b", undefined)).toBeNull();
    expect(sectionOrganization(null, "org_b", [])).toBeNull();
  });
});
