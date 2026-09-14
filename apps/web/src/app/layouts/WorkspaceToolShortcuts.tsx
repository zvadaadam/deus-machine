import { Settings2 } from "lucide-react";
import type { ContentTab } from "@/features/workspace/store";
import type { ContentTabItem } from "./content-tabs";

export function WorkspaceToolShortcuts({
  items,
  onSelect,
  onEnvironment,
}: {
  items: ContentTabItem[];
  onSelect: (tab: ContentTab) => void;
  onEnvironment: () => void;
}) {
  return (
    <aside
      aria-label="Workspace tools"
      className="text-text-muted hidden w-48 shrink-0 flex-col gap-1 pt-16 pr-6 @[960px]:flex"
    >
      {items.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          type="button"
          onClick={() => onSelect(id)}
          className="control-interaction hover:bg-control-hover active:bg-control-pressed hover:text-text-secondary flex h-8 items-center gap-3 rounded-lg px-2 text-sm"
        >
          <Icon className="size-4" aria-hidden="true" />
          {label}
        </button>
      ))}
      <div className="border-border-subtle my-2 border-t" />
      <button
        type="button"
        onClick={onEnvironment}
        className="control-interaction hover:bg-control-hover active:bg-control-pressed hover:text-text-secondary flex h-8 items-center gap-3 rounded-lg px-2 text-sm"
      >
        <Settings2 className="size-4" aria-hidden="true" />
        Environment
      </button>
    </aside>
  );
}
