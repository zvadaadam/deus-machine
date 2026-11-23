import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import type { PRStatus, Workspace } from "@/shared/types";
import { derivePRActionState, type PRActionState } from "@/features/workspace/lib/prState";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PRActions } from "@/features/workspace/ui/PRActions";
import { MobilePRHeaderAction, MobilePRStatusBar } from "@/app/layouts/MobilePRBar";

const settled = { isLoading: false, isFetched: true, isEnabled: true, isError: false };
const saved = { pr_number: 12, pr_url: "/pr/12" } as Workspace;
const readyPR = {
  has_pr: true,
  pr_number: 12,
  pr_url: "/pr/12",
  pr_state: "open",
  merge_status: "ready",
  base_branch: "release/next",
} as const;

it("waits only for the first enabled PR lookup, including when that read fails", async () => {
  const client = new QueryClient();
  let answer = Promise.withResolvers<PRStatus>();
  const options = { queryKey: ["prStatus"], queryFn: () => answer.promise, retry: false };
  const observer = new QueryObserver(client, { ...options, enabled: false });
  const unsubscribe = observer.subscribe(() => {});
  const state = () => derivePRActionState(observer.getCurrentResult(), undefined).type;
  try {
    const first = observer.refetch();
    expect(state()).toBe("create_pr");
    observer.setOptions({ ...options, enabled: true });
    expect(state()).toBe("checking");
    answer.reject(new Error("Read failed"));
    await first;
    expect(state()).toBe("create_pr");

    answer = Promise.withResolvers<PRStatus>();
    const next = observer.refetch();
    expect(state()).toBe("create_pr");
    answer.resolve(readyPR);
    await next;
    answer = Promise.withResolvers<PRStatus>();
    const refresh = observer.refetch();
    expect(state()).toBe("ready_to_merge");
    answer.reject(new Error("Read failed"));
    await refresh;
    const result = observer.getCurrentResult();
    expect(result.data).toEqual(readyPR);
    expect(
      derivePRActionState(result, undefined, {
        ...saved,
        pr_state: "open",
        pr_ci_status: "unknown",
      }).type
    ).toBe("linked");
  } finally {
    unsubscribe();
    client.clear();
  }
});

it.each([
  ["timeout", "create_pr", "GitHub took too long to check for a pull request."],
  ["unknown", "create_pr", "Could not check for a pull request on GitHub."],
  [
    "gh_not_installed",
    "gh_unavailable",
    "GitHub integration is unavailable on this computer. Check Settings.",
  ],
  [
    "gh_not_authenticated",
    "gh_unavailable",
    "Connect GitHub in Settings to check for a pull request.",
  ],
] as const)("uses the workspace's saved PR when a lookup reports %s", (error, type, warning) => {
  const lookup = { ...settled, data: { has_pr: false, error } };
  expect(derivePRActionState(lookup, undefined)).toEqual({ type, warning });
  expect(derivePRActionState(lookup, undefined, { ...saved, pr_state: "merged" })).toEqual({
    type: "merged",
    prNumber: 12,
    prUrl: "/pr/12",
  });
  const passing = { ...saved, pr_state: "open", pr_ci_status: "passing" } as const;
  expect(derivePRActionState(lookup, undefined, passing)).toEqual({
    type: "linked",
    prNumber: 12,
    prUrl: "/pr/12",
    warning,
  });
});

it.each([
  ["gh_not_installed", { isInstalled: false, isAuthenticated: false }],
  ["gh_not_authenticated", { isInstalled: true, isAuthenticated: false }],
] as const)("treats %s from the CLI status and the lookup alike", (error, ghStatus) => {
  const disabled = { ...settled, isEnabled: false, isFetched: false, data: undefined };
  const failed = { ...settled, data: { has_pr: false, error } };
  for (const workspace of [undefined, { ...saved, pr_state: "closed" } as const]) {
    expect(derivePRActionState(disabled, ghStatus, workspace)).toEqual(
      derivePRActionState(failed, undefined, workspace)
    );
  }
});

it("shows a picked PR until a conclusive lookup rules it out", () => {
  const lookup = { ...settled, data: { has_pr: false, error: "unknown" } } as const;
  expect(derivePRActionState(lookup, undefined, saved).type).toBe("linked");
  const checked = { ...saved, pr_checked_at: "2026-11-23" };
  expect(derivePRActionState(lookup, undefined, checked).type).toBe("create_pr");
  expect(
    derivePRActionState({ ...settled, data: { has_pr: false, conclusive: true } }, undefined, saved)
  ).toEqual({ type: "create_pr" });
});

it("keeps a saved review requirement through a failed lookup", () => {
  const lookup = { ...settled, data: { has_pr: false, error: "timeout" } } as const;
  const workspace = { ...saved, pr_state: "open", pr_review_status: "review_required" } as const;
  expect(derivePRActionState(lookup, undefined, workspace).type).toBe("awaiting_review");
});

it("names the PR's base on both Merge buttons", () => {
  const state = derivePRActionState({ ...settled, data: readyPR }, undefined);
  expect(state).toEqual({
    type: "ready_to_merge",
    prNumber: 12,
    prUrl: "/pr/12",
    baseBranch: "release/next",
  });
  const props = { state, targetBranch: "main", onTargetBranchChange: vi.fn() };
  for (const component of [PRActions, MobilePRStatusBar]) {
    const html = renderToStaticMarkup(
      createElement(TooltipProvider, null, createElement(component, props))
    );
    expect(html).toContain("Merge into release/next");
    expect(html).not.toContain("Merge into main");
  }
});

it("renders the failed lookup beside Create PR and keeps the chosen creation target", () => {
  const state: PRActionState = {
    type: "create_pr",
    warning: "Could not check for a pull request on GitHub.",
  };
  const props = {
    state,
    targetBranch: "my-target",
    onCreatePR: vi.fn(),
    onTargetBranchChange: vi.fn(),
  };
  const client = new QueryClient();
  for (const component of [PRActions, MobilePRHeaderAction]) {
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TooltipProvider, null, createElement(component, props))
      )
    );
    expect(html).toContain("Create PR");
    expect(html).toContain(`aria-label="${state.warning}"`);
    if (component === PRActions) expect(html).toContain("my-target");
  }
  client.clear();
});
