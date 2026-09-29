import { beforeEach, expect, it } from "vitest";
import {
  projectTabsActions,
  useProjectTabsStore,
} from "@/features/projects/store/projectTabsStore";

const tabs = (projectId = "p") => useProjectTabsStore.getState().projects[projectId];

beforeEach(() => useProjectTabsStore.setState({ projects: {} }));

it("opens agents beside the pinned coordinator and focuses each one", () => {
  projectTabsActions.open("p", "a");
  projectTabsActions.open("p", "b");
  expect(tabs()).toEqual({ agentIds: ["a", "b"], activeAgentId: "b" });
  projectTabsActions.open("p", "a");
  expect(tabs()).toEqual({ agentIds: ["a", "b"], activeAgentId: "a" });
  projectTabsActions.open("p", null);
  expect(tabs()).toEqual({ agentIds: ["a", "b"], activeAgentId: null });
});

it("closing the visible tab shows its left neighbour, ending at the coordinator", () => {
  projectTabsActions.open("p", "a");
  projectTabsActions.open("p", "b");
  projectTabsActions.close("p", "b");
  expect(tabs()).toEqual({ agentIds: ["a"], activeAgentId: "a" });
  projectTabsActions.close("p", "a");
  expect(tabs()).toEqual({ agentIds: [], activeAgentId: null });
});

it("keeps the selection when a background tab closes, and tabs are per Project", () => {
  projectTabsActions.open("p", "a");
  projectTabsActions.open("p", "b");
  projectTabsActions.open("other", "c");
  projectTabsActions.close("p", "a");
  expect(tabs()).toEqual({ agentIds: ["b"], activeAgentId: "b" });
  expect(tabs("other")).toEqual({ agentIds: ["c"], activeAgentId: "c" });
});

it("reorders only tabs that are open", () => {
  projectTabsActions.open("p", "a");
  projectTabsActions.open("p", "b");
  projectTabsActions.reorder("p", ["b", "stale", "a"]);
  expect(tabs()).toEqual({ agentIds: ["b", "a"], activeAgentId: "b" });
});
