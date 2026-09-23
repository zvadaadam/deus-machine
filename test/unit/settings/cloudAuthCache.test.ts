import { expect, it, vi } from "vitest";
import { applyDeusCloudAuthChange } from "@/shared/api/cloudAuthCache";

it("resets Slack settings on Deus Cloud account changes", () => {
  const queryClient = {
    setQueryData: vi.fn(),
    resetQueries: vi.fn(),
  };
  applyDeusCloudAuthChange(
    queryClient as never,
    { signedIn: false, reason: "signed-out" } as never
  );
  expect(queryClient.resetQueries).toHaveBeenCalledWith({ queryKey: ["settings", "slack"] });
});
