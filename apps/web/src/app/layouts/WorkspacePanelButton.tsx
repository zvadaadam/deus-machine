import { Maximize2, Minimize2, PanelRightClose, PanelRightOpen } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const actions = {
  hide: { icon: PanelRightClose, label: "Hide workspace" },
  show: { icon: PanelRightOpen, label: "Show workspace" },
  expand: { icon: Maximize2, label: "Expand workspace" },
  restore: { icon: Minimize2, label: "Restore split" },
};

export function WorkspacePanelButton({
  action,
  onClick,
}: {
  action: keyof typeof actions;
  onClick: () => void;
}) {
  const { icon: Icon, label } = actions[action];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          className="control-interaction no-drag text-text-muted hover:text-text-secondary hover:bg-control-hover active:bg-control-pressed flex size-7 shrink-0 items-center justify-center rounded-lg"
        >
          <Icon className="size-4" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
