import {
  Children,
  createElement,
  isValidElement,
  type ComponentProps,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { NewProjectDialog } from "@/features/projects/ui/NewProjectDialog";
import { NewWorkspacePromptModal } from "@/features/repository/ui/NewWorkspacePromptModal";
import { getDefaultModelForHarness, MODEL_OPTIONS } from "@/shared/agents";

type ModalProps = ComponentProps<typeof NewWorkspacePromptModal>;
const state = vi.hoisted(() => ({
  create: vi.fn(),
  onCreated: vi.fn(),
  onClose: vi.fn(),
  submit: vi.fn(),
  pending: false,
  error: null as Error | null,
  modal: null as ModalProps | null,
  closeDialog: null as ((open: boolean) => void) | null,
  buttons: new Map<string, { disabled: boolean; onClick: () => void }>(),
  storedModel: "codex-app-server:gpt-5.4",
  setStoredModel: vi.fn(),
}));

vi.mock("@/features/projects/api/projects.queries", () => ({
  useCreateProject: () => ({
    mutateAsync: state.create,
    isPending: state.pending,
    isError: !!state.error,
    error: state.error,
  }),
}));
vi.mock("@/features/repository/ui/NewWorkspacePromptModal", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/repository/ui/NewWorkspacePromptModal")>();
  return {
    NewWorkspacePromptModal: (props: ModalProps) => {
      state.modal = props;
      return createElement(actual.NewWorkspacePromptModal, props);
    },
  };
});
vi.mock("@/features/session/lib/modelPreference", () => ({
  getStoredModel: () => state.storedModel,
  setStoredModel: state.setStoredModel,
}));
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    children,
    onOpenChange,
  }: {
    children: ReactNode;
    onOpenChange: (open: boolean) => void;
  }) => {
    state.closeDialog = onOpenChange;
    return children;
  },
  DialogTitle: ({ children }: { children: ReactNode }) => createElement("h1", null, children),
  DialogContent: ({ children }: { children: ReactNode }) => {
    const capture = (nodes: ReactNode) =>
      Children.forEach(nodes, (node) => {
        if (!isValidElement<Record<string, unknown>>(node)) return;
        if (node.type === "button")
          state.buttons.set(String(node.props["aria-label"]), node.props as never);
        capture(node.props.children as ReactNode);
      });
    capture(children);
    return createElement("div", null, children);
  },
}));
vi.mock("@/components/ui/select", () => {
  const container = ({ children }: { children: ReactNode }) => children;
  return {
    Select: container,
    SelectTrigger: container,
    SelectContent: container,
    SelectItem: container,
    SelectValue: () => null,
  };
});
vi.mock("@/components/ui/popover", () => {
  const container = ({ children }: { children: ReactNode }) => children;
  return { Popover: container, PopoverTrigger: container, PopoverContent: container };
});
vi.mock("@/shared/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/assets/agents", () => ({ getAgentLogo: () => undefined }));
vi.mock("@/features/repository/ui/composer/ComposerControls", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/repository/ui/composer/ComposerControls")>();
  return {
    ...actual,
    CloudToggle: () => createElement("span", null, "Cloud toggle"),
    BranchPickerButton: () => createElement("span", null, "Branch picker"),
  };
});

const repos = [
  { id: "repo", name: "Repository", root_path: "/fixture", git_default_branch: "main" },
];
const props = {
  show: true,
  repos,
  selectedRepoId: "repo",
  creating: false,
  onClose: state.onClose,
  onRepoChange: vi.fn(),
  onSubmit: state.submit,
};

beforeEach(() => {
  vi.clearAllMocks();
  state.create.mockResolvedValue({ id: "created-project" });
  state.pending = false;
  state.error = null;
  state.buttons.clear();
});

it("starts a Project from a name alone, with an optional brief and only local Claude", () => {
  const html = renderToStaticMarkup(
    createElement(NewWorkspacePromptModal, { ...props, kind: "project" })
  );
  expect(state.buttons.get("Start project")?.disabled).toBe(false);
  expect(html).toContain('aria-label="Project name"');
  expect(html).toContain('placeholder="Repository"');
  expect(html).not.toContain('required=""');
  expect(html).toContain("Optional");
  expect(html).not.toContain("Cloud toggle");
  expect(html).not.toContain("Branch picker");
  for (const option of MODEL_OPTIONS.filter((model) => model.agentHarness !== "claude-code")) {
    expect(html).not.toContain(option.label);
  }
  state.buttons.get("Start project")!.onClick();
  expect(state.submit).toHaveBeenLastCalledWith({
    repoId: "repo",
    prompt: "",
    title: "",
    location: "local",
    model: getDefaultModelForHarness("claude-code"),
    branch: undefined,
  });
  renderToStaticMarkup(
    createElement(NewWorkspacePromptModal, {
      ...props,
      kind: "project",
      initialPrompt: "Ship the result",
    })
  );
  state.buttons.get("Start project")!.onClick();
  expect(state.submit).toHaveBeenLastCalledWith({
    repoId: "repo",
    prompt: "Ship the result",
    title: "",
    location: "local",
    model: getDefaultModelForHarness("claude-code"),
    branch: undefined,
  });
  expect(state.setStoredModel).not.toHaveBeenCalled();
});

it("retains workspace empty-prompt creation and its model, branch, and cloud controls", () => {
  const html = renderToStaticMarkup(createElement(NewWorkspacePromptModal, props));
  expect(html).toContain("Cloud toggle");
  expect(html).toContain("Branch picker");
  expect(state.buttons.get("Create workspace")?.disabled).toBe(false);
  state.buttons.get("Create workspace")!.onClick();
  expect(state.submit).toHaveBeenCalledWith({
    repoId: "repo",
    prompt: "",
    location: "local",
    model: state.storedModel,
    branch: undefined,
  });
});

it("derives a title and retries failed creation with the same instruction and request ID", async () => {
  state.create.mockRejectedValueOnce(new Error("Offline"));
  renderToStaticMarkup(
    createElement(NewProjectDialog, {
      repos,
      selectedRepoId: "repo",
      onRepoChange: vi.fn(),
      onClose: state.onClose,
      onCreated: state.onCreated,
    })
  );
  const submit = state.modal!.onSubmit;
  const input = {
    repoId: "repo",
    prompt: ` ${"A".repeat(150)}\nKeep all acceptance criteria. `,
    location: "local" as const,
    model: "claude-code:claude-sonnet-4-6",
  };
  await submit(input);
  expect(state.onCreated).not.toHaveBeenCalled();
  expect(state.onClose).not.toHaveBeenCalled();
  await submit(input);
  expect(state.create.mock.calls[0]).toEqual(state.create.mock.calls[1]);
  expect(state.create.mock.calls[0][0]).toMatchObject({
    title: "A".repeat(120),
    brief: input.prompt.trim(),
    repositoryId: "repo",
  });
  expect(state.onCreated).toHaveBeenCalledWith("created-project");
  await submit({ ...input, prompt: "A different outcome" });
  expect(state.create.mock.calls[2][0].requestId).not.toBe(state.create.mock.calls[0][0].requestId);
  // A typed name wins; with nothing typed the repository names the Project and
  // the brief stays empty so the coordinator asks for it.
  await submit({ ...input, title: "  Billing launch  " });
  expect(state.create.mock.calls[3][0]).toMatchObject({ title: "Billing launch" });
  await submit({ ...input, prompt: "", title: "" });
  expect(state.create.mock.calls[4][0]).toMatchObject({
    title: "Repository",
    brief: "",
    repositoryId: "repo",
  });
});

it("keeps a pending Project prompt visible and prevents another submit or dismissal", () => {
  const html = renderToStaticMarkup(
    createElement(NewWorkspacePromptModal, {
      ...props,
      kind: "project",
      initialPrompt: "Keep this outcome",
      creating: true,
      error: "Connection interrupted",
    })
  );
  expect(html).toContain("Keep this outcome");
  expect(html).toContain('role="alert"');
  expect(state.buttons.get("Start project")?.disabled).toBe(true);
  state.buttons.get("Start project")!.onClick();
  state.closeDialog!(false);
  expect(state.submit).not.toHaveBeenCalled();
  expect(state.onClose).not.toHaveBeenCalled();
});
