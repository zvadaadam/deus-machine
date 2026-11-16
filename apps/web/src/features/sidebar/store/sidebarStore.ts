import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  pendingCloudOutcome,
  type CloudRowState,
  type Organizations,
  type Place,
  type WorkspaceLocation,
} from "../lib/location";

interface SidebarState {
  // Sidebar-specific state
  collapsedRepos: Set<string>;
  toggleRepoCollapse: (repoId: string) => void;
  expandRepo: (repoId: string) => void;

  // Repos where user expanded the "Show more" stale workspaces
  expandedOldWorkspaces: Set<string>;
  toggleOldWorkspaces: (repoId: string) => void;

  // Repository ordering
  repositoryOrder: string[];
  setRepositoryOrder: (order: string[]) => void;
  reorderRepositories: <T extends { repo_id: string }>(repos: T[]) => T[];

  // Where this window's workspaces run, and in the cloud the organization last chosen
  // (both persisted; an organization the list does not name falls back to the default
  // one). The workspace last selected in each place during this app session is memory
  // only, keyed by `placeKey`.
  location: WorkspaceLocation;
  cloudOrganizationId: string | null;
  /** Go to a place. A cloud place naming no organization keeps the one last chosen. */
  setPlace: (place: Place) => void;
  lastSelectedByPlace: Partial<Record<string, string>>;
  rememberSelection: (placeKey: string, workspaceId: string) => void;

  // A Deus Cloud sign-in (or a setup) started from the location menu, memory only: once
  // the cloud (or that organization) is reachable, the window moves there.
  cloudPending: { organizationId: string | null } | null;
  // A setup started from the location menu is running (memory only).
  cloudSetupRetrying: boolean;
}

export const useSidebarStore = create<SidebarState>()(
  persist(
    (set, get) => ({
      // Existing state
      collapsedRepos: new Set(),
      toggleRepoCollapse: (repoId) =>
        set((state) => {
          const newCollapsed = new Set(state.collapsedRepos);
          if (newCollapsed.has(repoId)) {
            newCollapsed.delete(repoId);
          } else {
            newCollapsed.add(repoId);
          }
          return { collapsedRepos: newCollapsed };
        }),
      expandRepo: (repoId) =>
        set((state) => {
          if (!state.collapsedRepos.has(repoId)) return state;
          const newCollapsed = new Set(state.collapsedRepos);
          newCollapsed.delete(repoId);
          return { collapsedRepos: newCollapsed };
        }),

      // Stale workspace expansion (per-repo)
      expandedOldWorkspaces: new Set(),
      toggleOldWorkspaces: (repoId) =>
        set((state) => {
          const next = new Set(state.expandedOldWorkspaces);
          if (next.has(repoId)) {
            next.delete(repoId);
          } else {
            next.add(repoId);
          }
          return { expandedOldWorkspaces: next };
        }),

      location: "local",
      cloudOrganizationId: null,
      setPlace: (place) =>
        set((state) => {
          const cloudOrganizationId =
            place.location === "cloud" && place.organizationId
              ? place.organizationId
              : state.cloudOrganizationId;
          return state.location === place.location &&
            state.cloudOrganizationId === cloudOrganizationId
            ? state
            : { location: place.location, cloudOrganizationId };
        }),
      lastSelectedByPlace: {},
      rememberSelection: (placeKey, workspaceId) =>
        set((state) =>
          state.lastSelectedByPlace[placeKey] === workspaceId
            ? state
            : { lastSelectedByPlace: { ...state.lastSelectedByPlace, [placeKey]: workspaceId } }
        ),
      cloudPending: null,
      cloudSetupRetrying: false,

      // Repository ordering
      repositoryOrder: [],

      /**
       * Save the order of the repositories in view. The order is shared by every
       * computer opened in this browser, so ids not in view keep their places
       * and the ones in view fill their slots in the new order.
       */
      setRepositoryOrder: (order) =>
        set((state) => {
          const inView = new Set(order);
          const placed = [...order];
          const merged = state.repositoryOrder.map((id) => (inView.has(id) ? placed.shift()! : id));
          return { repositoryOrder: [...merged, ...placed] };
        }),

      /**
       * Reorder repositories based on user preferences
       * Unordered repos appear at the end in their original order
       */
      reorderRepositories: (repos) => {
        const { repositoryOrder } = get();

        // If no custom order, return as-is
        if (repositoryOrder.length === 0) return repos;

        // Create lookup map for O(1) access
        const orderMap = new Map(repositoryOrder.map((id, idx) => [id, idx]));

        return [...repos].sort((a, b) => {
          const indexA = orderMap.get(a.repo_id) ?? Infinity;
          const indexB = orderMap.get(b.repo_id) ?? Infinity;
          return indexA - indexB;
        });
      },
    }),
    {
      name: "sidebar-storage",
      // Serialize Set properly for localStorage
      partialize: (state) => ({
        collapsedRepos: Array.from(state.collapsedRepos),
        expandedOldWorkspaces: Array.from(state.expandedOldWorkspaces),
        repositoryOrder: state.repositoryOrder,
        location: state.location,
        cloudOrganizationId: state.cloudOrganizationId,
      }),
      merge: (persistedState: any, currentState) => ({
        ...currentState,
        collapsedRepos: new Set(persistedState?.collapsedRepos || []),
        expandedOldWorkspaces: new Set(persistedState?.expandedOldWorkspaces || []),
        repositoryOrder: persistedState?.repositoryOrder || [],
        // Added without a version bump: the merge defaults it for older saves.
        location: persistedState?.location === "cloud" ? "cloud" : "local",
        cloudOrganizationId:
          typeof persistedState?.cloudOrganizationId === "string"
            ? persistedState.cloudOrganizationId
            : null,
      }),
    }
  )
);

/**
 * Sign in to Deus Cloud from the location menu (or ⌃2). The intent stays until the
 * sign-in fails or is cancelled, the cloud is reachable, or its setup fails
 * (`finishCloudSignIn`): a sign-in that succeeds still waits for this computer's key.
 */
export async function startCloudSignIn(signIn: () => Promise<{ success: boolean }>): Promise<void> {
  useSidebarStore.setState({ cloudPending: { organizationId: null } });
  const signedIn = await signIn().then(
    (result) => result.success,
    () => false
  );
  if (!signedIn) useSidebarStore.setState({ cloudPending: null });
}

/**
 * Set this computer's cloud up again (the cloud row's Retry, an organization's Set up),
 * with the same intent as a sign-in: the window moves to `organizationId` (or, with
 * none, the cloud) once it is ready. Recorded together with the running setup, so the
 * row never offers it again while one runs; a setup that fails ends the intent.
 * `moveWindow: false` (the composer's Set up) runs the same setup with no intent: the
 * window stays where it is.
 */
export async function retryCloudSetup(
  retry: () => Promise<{ ok: boolean; error?: string }>,
  organizationId: string | null = null,
  { moveWindow = true }: { moveWindow?: boolean } = {}
): Promise<{ ok: boolean; error?: string }> {
  useSidebarStore.setState(
    moveWindow
      ? { cloudPending: { organizationId }, cloudSetupRetrying: true }
      : { cloudSetupRetrying: true }
  );
  const result = await retry().catch((error: unknown) => ({
    ok: false,
    error: error instanceof Error ? error.message : undefined,
  }));
  useSidebarStore.setState((state) => ({
    cloudSetupRetrying: false,
    cloudPending: result.ok || !moveWindow ? state.cloudPending : null,
  }));
  return result;
}

/**
 * A pending sign-in or setup, each time the backend's pushed value changes: once the
 * place it waits for is reachable, the window moves there, once; once the setup has
 * failed (the cloud row offers Retry), it ends.
 */
export function finishCloudSignIn(
  { organizations, cloudRow }: { organizations: Organizations; cloudRow: CloudRowState },
  switchTo: (place: Place) => void
): void {
  const pending = useSidebarStore.getState().cloudPending;
  if (!pending) return;
  const outcome = pendingCloudOutcome(pending, organizations, cloudRow);
  if (outcome === "wait") return;
  useSidebarStore.setState({ cloudPending: null });
  if (outcome !== "end") switchTo(outcome);
}
