import { expect, it, vi } from "vitest";
import { applyDeusCloudAuthChange, isRepoBranchesQuery } from "@/shared/api/cloudAuthCache";
import { queryKeys } from "@/shared/api/queryKeys";

const signOut = () => {
  const queryClient = {
    setQueryData: vi.fn(),
    resetQueries: vi.fn(),
  };
  applyDeusCloudAuthChange(
    queryClient as never,
    { signedIn: false, reason: "signed-out" } as never
  );
  return queryClient;
};

it("resets Slack settings on Deus Cloud account changes", () => {
  expect(signOut().resetQueries).toHaveBeenCalledWith({ queryKey: ["settings", "slack"] });
});

it("resets the account's organizations, so the next account's are read", () => {
  expect(signOut().resetQueries).toHaveBeenCalledWith({ queryKey: ["cloudOrganizations"] });
});

it("resets every project's branches, read from GitHub with an organization's token", () => {
  const { resetQueries } = signOut();
  expect(resetQueries).toHaveBeenCalledWith({ predicate: isRepoBranchesQuery });
  const matches = (queryKey: readonly unknown[]) => isRepoBranchesQuery({ queryKey });
  expect(matches(queryKeys.repos.branches("repo", "acme"))).toBe(true);
  expect(matches(queryKeys.repos.branches("repo"))).toBe(true);
  expect(matches(queryKeys.repos.prs("repo"))).toBe(false);
  expect(matches(queryKeys.repos.detail("repo"))).toBe(false);
});
