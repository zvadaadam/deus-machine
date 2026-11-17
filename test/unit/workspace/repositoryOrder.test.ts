import { beforeEach, describe, expect, it } from "vitest";
import { useSidebarStore } from "@/features/sidebar/store/sidebarStore";

const order = () => useSidebarStore.getState().repositoryOrder;
const save = (ids: string[]) => useSidebarStore.getState().setRepositoryOrder(ids);

describe("saving the sidebar's repository order", () => {
  beforeEach(() => useSidebarStore.setState({ repositoryOrder: [] }));

  it("keeps the repositories of other computers, in their places", () => {
    // This computer shows a, b and c; another one opened in this browser showed x and y.
    useSidebarStore.setState({ repositoryOrder: ["a", "x", "b", "y", "c"] });

    save(["c", "a", "b"]);

    expect(order()).toEqual(["c", "x", "a", "y", "b"]);
  });

  it("adds repositories it has not ordered before at the end", () => {
    useSidebarStore.setState({ repositoryOrder: ["x", "a"] });

    save(["b", "a"]);

    expect(order()).toEqual(["x", "b", "a"]);
  });

  it("stores the order as given when nothing was stored", () => {
    save(["b", "a"]);

    expect(order()).toEqual(["b", "a"]);
  });

  it("orders the repositories in view as dragged", () => {
    useSidebarStore.setState({ repositoryOrder: ["a", "x", "b"] });
    save(["b", "a"]);

    const repos = [{ repo_id: "a" }, { repo_id: "b" }];
    expect(useSidebarStore.getState().reorderRepositories(repos)).toEqual([
      { repo_id: "b" },
      { repo_id: "a" },
    ]);
  });
});
