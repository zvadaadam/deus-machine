import {
  createElement,
  type ComponentProps,
  type EffectCallback,
  type ReactNode,
  type SetStateAction,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { ProjectFilePane, type ProjectFileSelection } from "@/features/projects/ui/ProjectFilePane";

const state = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  cleanup: undefined as ReturnType<EffectCallback>,
  buttons: [] as ComponentProps<"button">[],
  textareas: [] as ComponentProps<"textarea">[],
  publish: vi.fn(),
  latest: { content: "Their edit", revision: 9 },
}));

// Drive the real pane's event handlers across rerenders without a browser DOM.
// UI primitives and network mutations are the only other substituted boundaries.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: <T>(initial: T | (() => T)) => {
      const index = state.cursor++;
      if (!(index in state.slots))
        state.slots[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      return [
        state.slots[index],
        (value: SetStateAction<T>) => {
          state.slots[index] =
            typeof value === "function"
              ? (value as (previous: T) => T)(state.slots[index] as T)
              : value;
        },
      ];
    },
    useRef: <T>(initial: T) => {
      const index = state.cursor++;
      if (!(index in state.slots)) state.slots[index] = { current: initial };
      return state.slots[index];
    },
    useEffect: (effect: EffectCallback) => {
      state.cleanup = effect();
    },
  };
});
vi.mock("@/components/ui", () => ({
  Button: ({ children, ...props }: ComponentProps<"button">) => {
    state.buttons.push({ ...props, children });
    return createElement("button", props, children);
  },
  Textarea: (props: ComponentProps<"textarea">) => {
    state.textareas.push(props);
    return createElement("textarea", props);
  },
}));
vi.mock("@/features/file-browser/ui/FilePreview", () => ({
  FilePreview: ({ actions }: { actions: ReactNode }) => actions,
}));
vi.mock("@/platform", () => ({ native: { window: { openExternal: vi.fn() } } }));
vi.mock("@/shared/api/client", () => ({ apiClient: { get: vi.fn() } }));
vi.mock("@/features/projects/api/projects.queries", () => ({
  useProjectFile: () => ({ data: { content: "Original", revision: 7 } }),
  useProjectAction: () => ({ isPending: false, mutateAsync: state.publish, reset: vi.fn() }),
}));
vi.mock("@tanstack/react-query", () => ({
  useMutation: ({ onSuccess }: { onSuccess: (value: typeof state.latest) => void }) => ({
    isPending: false,
    reset: vi.fn(),
    mutate: () => onSuccess(state.latest),
  }),
}));

const file: ProjectFileSelection = {
  path: "brief.md",
  revision: 7,
  editable: true,
  availablePaths: ["brief.md"],
};
const onOpenFile = vi.fn();
beforeEach(() => {
  state.slots = [];
  state.publish.mockReset().mockResolvedValue({ revision: 10 });
  onOpenFile.mockClear();
});

function render(selection = file) {
  state.cursor = 0;
  state.buttons = [];
  state.textareas = [];
  return renderToStaticMarkup(
    createElement(ProjectFilePane, {
      projectId: "project",
      file: selection,
      onClose: vi.fn(),
      onOpenFile,
    })
  );
}
function button(label: string) {
  return state.buttons.find((props) =>
    renderToStaticMarkup(createElement("span", null, props.children)).includes(label)
  )!;
}
async function click(label: string) {
  const control = button(label);
  expect(control.disabled).not.toBe(true);
  await control.onClick!({} as never);
}
async function edit() {
  render();
  await click("Edit file");
  render();
  state.textareas.find((props) => props["aria-label"] === "File content")!.onChange!({
    target: { value: "My draft" },
  } as never);
  render();
}

it("preserves the draft through a conflict and publishes only after comparing latest", async () => {
  await edit();
  state.publish.mockRejectedValueOnce({ status: 409 });
  await click("Publish changes");
  expect(render()).toContain("Your draft is still here");
  expect(button("Publish changes").disabled).toBe(true);
  expect(state.textareas.find((props) => props["aria-label"] === "File content")!.value).toBe(
    "My draft"
  );
  await click("Load latest version");
  render();
  expect(
    state.textareas.find((props) => props["aria-label"] === "Latest published content")!.value
  ).toBe("Their edit");
  await click("Publish my draft");
  expect(
    state.publish.mock.calls.map(([input]) => [input.content, input.expectedRevision])
  ).toEqual([
    ["My draft", 7],
    ["My draft", 9],
  ]);
  expect(onOpenFile).toHaveBeenCalledExactlyOnceWith({ ...file, revision: 10 });
});

it("allows leaving edit mode if the project is archived during editing", async () => {
  await edit();
  render({ ...file, editable: false });
  expect(button("Publish changes").disabled).toBe(true);
  await click("Cancel");
  render({ ...file, editable: false });
  expect(state.textareas).toEqual([]);
  expect(state.publish).not.toHaveBeenCalled();
});

it("does not reopen a document after navigating away during publication", async () => {
  await edit();
  let complete!: (value: { revision: number }) => void;
  state.publish.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      })
  );
  const publishing = click("Publish changes");
  state.cleanup?.();
  complete({ revision: 8 });
  await publishing;
  expect(onOpenFile).not.toHaveBeenCalled();
});
